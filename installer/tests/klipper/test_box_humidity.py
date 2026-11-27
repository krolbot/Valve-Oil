"""vo_box_humidity: a print that takes a QIDI Box slot whose filament takes up moisture, while that Box is humid,
gets a console line and a printer warning, and nothing else. The print's own commands run unchanged, and the module
never heats a Box or starts QIDI's drying."""
from __future__ import annotations

import logging
import tempfile
import types
import unittest
from pathlib import Path

from installer.tests.klipper_fakes import CommandError, Reactor, load_extra

humidity_module = load_extra("box_humidity")
printer_warnings = load_extra("printer_warnings")


class GCmd:
    def __init__(self, params, responses):
        self.params, self.responses = params, responses

    def get(self, name, default=None):
        return self.params.get(name, default)

    def respond_info(self, message):
        self.responses.append(message)


class GCode:
    error = CommandError

    def __init__(self):
        self.commands, self.responses, self.scripts = {}, [], []
        self.gcode_help = {}

    def register_command(self, name, handler, desc=None):
        if handler is None:
            return self.commands.pop(name, None)
        self.commands[name] = handler

    def respond_info(self, message):
        self.responses.append(message)

    def run_script(self, script):
        words = script.split()
        self.commands[words[0]](GCmd(dict(word.split("=", 1) for word in words[1:]), self.responses))

    def run_script_from_command(self, script):
        self.scripts.append(script)


class Status:
    def __init__(self, status):
        self.status = status

    def get_status(self, eventtime):
        return self.status


class Printer:
    def __init__(self, objects, config_file=None):
        self.objects = objects
        self.reactor = Reactor()
        self.handlers = {}
        self.config_file = config_file

    def get_reactor(self):
        return self.reactor

    def get_start_args(self):
        return {"config_file": self.config_file} if self.config_file else {}

    def is_shutdown(self):
        return False

    def register_event_handler(self, event, callback):
        self.handlers.setdefault(event, []).append(callback)

    def lookup_object(self, name, default=None):
        return self.objects.get(name, default)


class Config:
    def __init__(self, printer):
        self.printer = printer

    def get_printer(self):
        return self.printer


def info(index, kind, name="Generic Filament"):
    vendor, _, filament = name.partition(" ")
    return {"index": index, "filament_id": "QFX%02d" % index, "filament_str": filament, "vendor_str": vendor,
            "filament_type": kind, "box_max_temp": 45}


class Box:
    """Two USB QIDI Boxes on QIDI firmware that resolves each slot's filament: Box 1 holds PETG in 1A, PLA in 1B,
    PA12-CF in 1C and TPU in 1D; Box 2 holds PLA. T0-T7 map to 1A-2D."""

    def __init__(self, *, humidity=(52., 30.), variables=None, print_state="printing", dry_state=(0, 0),
                 types_box1=("PETG", "PLA", "PA12-CF", "TPU"), filament_info=True, config_file=None,
                 broken_status=False, controller=True):
        self.gcode = GCode()
        self.ran = []
        for name in ("BOX_PRINT_START", "T_MANAGER"):
            self.gcode.register_command(name, lambda gcmd, name=name: self.ran.append((name, dict(gcmd.params))))
        self.variables = {"box_count": 2, **{"value_t%d" % tool: "slot%d" % tool for tool in range(8)}}
        self.variables.update(variables or {})
        boxes = [{"dry_state": dry_state[0]}, {"dry_state": dry_state[1]}]
        if filament_info:
            boxes[0]["filament_info"] = [info(i, kind, "Generic " + kind) for i, kind in enumerate(types_box1)]
            boxes[1]["filament_info"] = [info(i, "PLA", "QIDI PLA Basic") for i in range(4)]
        self.sensors = [Status({"humidity": humidity[0], "temperature": 31.24}),
                        Status({"humidity": humidity[1], "temperature": 29.0})]
        self.print_stats = Status({"state": print_state})
        objects = {
            "gcode": self.gcode,
            "save_variables": types.SimpleNamespace(allVariables=self.variables),
            "print_stats": self.print_stats,
            "box_extras": Status({"boxes": boxes}) if not broken_status else None,
            "aht20_f heater_box1": self.sensors[0],
            "aht20_f heater_box2": self.sensors[1],
            "heater_generic heater_box1": Status({"target": 0.}),
        }
        if controller:
            # QIDI's multi-color controller, on the Max 4 from 01.01.07.01 and on the Plus 5 and Smart 5.
            objects["multi_color_controller"] = Status({})
        if broken_status:
            objects["aht20_f heater_box1"] = types.SimpleNamespace(get_status=lambda eventtime: 1 / 0)
        self.printer = Printer(objects, config_file)
        self.module = humidity_module.load_config(Config(self.printer))
        for callback in self.printer.handlers["klippy:ready"]:
            callback()
        (self.timer,) = self.printer.reactor.timers

    def run(self, script):
        self.gcode.run_script(script)

    def tick(self, seconds=0.):
        self.printer.reactor.now += seconds
        self.timer.callback(self.printer.reactor.now)

    def warnings(self):
        objects = {"vo_box_humidity": self.module}

        class WarningsPrinter:
            def get_printer(self):
                return self

            def get_start_args(self):
                return {}

            def register_event_handler(self, event, handler):
                pass

            def lookup_object(self, name, default=None):
                return objects.get(name, default)

        return [warning for warning in printer_warnings.PrinterWarnings(WarningsPrinter()).get_status(1.)["warnings"]
                if warning["id"].startswith("box_humidity")]


class QuietTestCase(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)


class BoxHumidityTests(QuietTestCase):
    def test_print_start_on_a_humid_box_warns_for_moisture_sensitive_filament_and_runs_unchanged(self):
        box = Box()
        box.run("BOX_PRINT_START EXTRUDER=0 HOTENDTEMP=250")
        self.assertEqual(box.ran, [("BOX_PRINT_START", {"EXTRUDER": "0", "HOTENDTEMP": "250"})])
        (line,) = box.gcode.responses
        for part in ("Box 1", "52 %", "Generic PETG", "1A", "40 %", "The print goes on"):
            self.assertIn(part, line)
        (warning,) = box.warnings()
        self.assertEqual((warning["id"], warning["level"]), ("box_humidity_box1", "warning"))
        self.assertIn("1A (Generic PETG)", warning["message"])
        self.assertEqual(box.module.get_status(0.)["alerts"][0]["slot"], "1A")
        self.assertEqual(box.gcode.scripts, [])

    def test_which_filament_types_count_as_taking_up_moisture(self):
        sensitive = ("PA", "PA-CF", "PA6-GF", "PA12-CF", "PAHT-CF", "PPA-CF", "UltraPA", "PET-CF", "PETG",
                     "PETG-CF", "TPU", "TPU-AERO 64D", "TPE", "TPEE", "PEBA", "PVA", "BVOH", "PC", "PC-ABS-FR",
                     "PPS-CF")
        not_sensitive = ("PLA", "PLA-CF", "PLA+", "ABS", "ASA", "ABS-GF", "HIPS", "")
        for kind in sensitive + not_sensitive:
            with self.subTest(kind):
                box = Box(types_box1=(kind, "PLA", "PLA", "PLA"))
                box.run("BOX_PRINT_START EXTRUDER=0")
                self.assertEqual(bool(box.warnings()), kind in sensitive)
                self.assertEqual(box.ran[0][0], "BOX_PRINT_START")

    def test_warning_level_is_inclusive_and_set_by_a_saved_variable(self):
        cases = {
            "at the default 40 %": (40., {}, True),
            "just below it": (39.9, {}, False),
            "at a saved 55 %": (55., {"vo_box_humidity_threshold": 55}, True),
            "below a saved 55 %": (54., {"vo_box_humidity_threshold": 55}, False),
            # A level outside 10-90 % is ignored for the default.
            "saved level out of range": (45., {"vo_box_humidity_threshold": 95}, True),
            "saved level not a number": (45., {"vo_box_humidity_threshold": "high"}, True),
        }
        for name, (humidity, variables, warns) in cases.items():
            with self.subTest(name):
                box = Box(humidity=(humidity, 30.), variables=variables)
                box.run("BOX_PRINT_START EXTRUDER=0")
                self.assertEqual(bool(box.warnings()), warns)

    def test_switched_off_it_says_nothing(self):
        for value in (0, "0"):
            with self.subTest(value=value):
                box = Box(variables={"vo_box_humidity_warning": value})
                box.run("BOX_PRINT_START EXTRUDER=0")
                box.run("T_MANAGER T=2")
                self.assertEqual((box.gcode.responses, box.warnings()), ([], []))
                self.assertEqual([name for name, _ in box.ran], ["BOX_PRINT_START", "T_MANAGER"])

    def test_tool_changes_check_the_slot_qidi_maps_the_tool_to_once_per_print(self):
        box = Box(variables={"value_t3": "slot2"})
        box.run("BOX_PRINT_START EXTRUDER=1")   # 1B, PLA
        self.assertEqual(box.warnings(), [])
        box.run("T_MANAGER T=3")                # mapped to 1C, PA12-CF
        box.run("T_MANAGER T=1")
        box.run("T_MANAGER T=3")
        self.assertEqual(len(box.gcode.responses), 1)
        self.assertIn("1C (Generic PA12-CF)", box.warnings()[0]["message"])
        # A tool on no connected Box prints from the external spool, which has no humidity sensor.
        box.variables["value_t4"] = "slot16"
        box.run("T_MANAGER T=4")
        box.run("T_MANAGER T=9")
        self.assertEqual(len(box.gcode.responses), 1)
        self.assertEqual(len(box.ran), 6)

    def test_a_tool_change_outside_a_print_says_nothing(self):
        """QIDI's tool change doesn't run outside a print (box_flow_recovery refuses it), so T0-T15 there never warn."""
        box = Box(print_state="standby")
        box.run("T_MANAGER T=0")
        self.assertEqual((box.gcode.responses, box.warnings()), ([], []))
        self.assertEqual([name for name, _ in box.ran], ["T_MANAGER"])

    def test_a_tool_without_a_mapping_is_checked_only_where_qidi_loads_the_same_numbered_slot(self):
        """QIDI's multi-color controller loads slot<tool> for a tool without a mapping. Earlier Max 4 firmware loads
        the external spool, which has no humidity sensor."""
        for controller in (True, False):
            with self.subTest(controller=controller):
                box = Box(controller=controller)
                del box.variables["value_t2"]   # 1C, PA12-CF
                box.run("T_MANAGER T=2")
                self.assertEqual(bool(box.warnings()), controller)
                self.assertEqual([name for name, _ in box.ran], ["T_MANAGER"])

    def test_warning_lasts_until_the_box_dries_or_the_next_print_starts(self):
        box = Box()
        box.run("BOX_PRINT_START EXTRUDER=0")
        box.print_stats.status["state"] = "complete"
        box.tick(5.)
        self.assertTrue(box.warnings())
        box.print_stats.status["state"] = "printing"
        box.run("BOX_PRINT_START EXTRUDER=1")
        self.assertEqual(box.warnings(), [])

        box = Box()
        box.run("BOX_PRINT_START EXTRUDER=0")
        box.sensors[0].status["humidity"] = 35.
        box.tick(5.)
        self.assertEqual(box.warnings(), [])

    def test_earlier_firmware_takes_the_filament_type_from_qidis_filament_list(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder)
            (config / "officiall_filas_list.cfg").write_text(
                "[fila1]\nfilament = PLA Rapido\ntype = PLA\n\n[fila39]\nfilament = PETG Basic\ntype = PETG\n")
            box = Box(filament_info=False, config_file=str(config / "printer.cfg"),
                      variables={"filament_slot0": 1, "filament_slot1": 39})
            box.run("BOX_PRINT_START EXTRUDER=0")
            self.assertEqual(box.warnings(), [])
            box.run("T_MANAGER T=1")
            self.assertIn("1B (PETG Basic)", box.warnings()[0]["message"])

    def test_a_failing_check_never_stops_the_print_command(self):
        box = Box(broken_status=True)
        box.run("BOX_PRINT_START EXTRUDER=0")
        box.run("T_MANAGER T=1")
        self.assertEqual([name for name, _ in box.ran], ["BOX_PRINT_START", "T_MANAGER"])

    def test_humid_idle_box_is_reported_but_never_heated_or_dried(self):
        box = Box(print_state="standby")
        for _ in range(int(3 * 3600 / humidity_module.CHECK_TIME)):
            box.tick(humidity_module.CHECK_TIME)
        self.assertEqual(box.gcode.scripts, [])
        self.assertEqual(box.printer.objects["heater_generic heater_box1"].status["target"], 0.)
        status = box.module.get_status(0.)
        box1, box2 = status["boxes"]
        self.assertEqual((box1["humidity"], box1["temperature"], box1["humid"]), (52, 31.2, True))
        self.assertGreaterEqual(box1["humid_minutes"], 179)
        self.assertEqual((box2["humid"], box2["humid_minutes"]), (False, None))
        self.assertEqual((status["warning_enabled"], status["threshold"]), (True, 40.))

    def test_status_command_lists_each_box_and_the_settings(self):
        box = Box(dry_state=(0, 1), variables={"vo_box_humidity_threshold": 50})
        box.run("BOX_PRINT_START EXTRUDER=0")
        box.run("VO_BOX_HUMIDITY")
        report = box.gcode.responses[-1]
        for part in ("Box 1: 52 % humidity, 31.2 °C, at or above the warning level for 0 min",
                     "Box 2: 30 % humidity, 29.0 °C, drying",
                     "Warning level: 50 % (vo_box_humidity_threshold).",
                     "Humidity check at print start: on (vo_box_humidity_warning).",
                     "Warning: 1A, Generic PETG (PETG), at 52 %."):
            self.assertIn(part, report)
        no_box = Box()
        del no_box.printer.objects["aht20_f heater_box1"], no_box.printer.objects["aht20_f heater_box2"]
        no_box.run("VO_BOX_HUMIDITY")
        self.assertIn("No QIDI Box humidity sensor found.", no_box.gcode.responses[-1])


if __name__ == "__main__":
    unittest.main()
