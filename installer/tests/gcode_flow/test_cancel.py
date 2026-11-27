"""Stopping a print from Fluidd or the touchscreen (CANCEL_PRINT), on every printer, while it prints and while it's
paused."""
from __future__ import annotations

import unittest

from installer.tests.gcode_flow import checks, slicer
from installer.tests.gcode_flow.printer import FIRMWARE, FlowPrinter
from installer.tests.gcode_flow.qidi import BoxSetup
from installer.tests.gcode_flow.test_power_loss_resume import WALL_LINES, saved_state, two_parts

PRINT_TEMPERATURE = 250.
FAN_OFF_BELOW = 170.
# How far a cancel drops the bed, mm, unless Z's travel ends sooner.
BED_DROP = 20.
PRINT = "\n".join(["G1 X100 Y100 E1 F3000", "G1 X120 Y100 E1 F3000", "_TEST_STOP", "G1 X140 Y100 E1 F3000"])


class CancelTests(checks.FlowTestCase):
    def printer(self, printer_id):
        # QIDI's _HOME_STATE flag (Plus 5 and Smart 5), which only QIDI's Z homing sets, stays 0 as after a power-loss
        # resume; the cancel goes by the axes Klipper has homed.
        return FlowPrinter(printer_id, box=BoxSetup())

    def register_stop(self, printer, nozzle=None, homed=None):
        """_TEST_STOP stops the print where the file has it, as Moonraker does: CANCEL_PRINT between two of the file's
        lines, with the nozzle at `nozzle` and only the axes in `homed` homed, if given."""
        stopped = {}

        def stop(gcmd):
            if nozzle is not None:
                printer.lookup_object("heaters").lookup_heater("extruder").set_smoothed_temp(nozzle)
            if homed is not None:
                printer.toolhead.homed.intersection_update(homed)
            stopped["moves"] = len(printer.toolhead.moves)
            stopped["trace"] = len(printer.trace)
            stopped["at"] = tuple(printer.toolhead.get_position()[:3])
            printer.gcode.run_script_from_command("CANCEL_PRINT")
        printer.gcode.register_command("_TEST_STOP", stop)
        return stopped

    def stop_while_printing(self, printer, nozzle=None, homed=None, z=2.):
        """Stops the print partway, with the nozzle `z` above the bed."""
        stopped = self.register_stop(printer, nozzle, homed)
        printer.start_print(PRINT, nozzle=PRINT_TEMPERATURE, at=(150., 150., z))
        return stopped

    def assert_parked(self, printer, stopped, *, drop, chute):
        """The cancel's moves: the bed `drop` mm lower first, then, if `chute`, the toolhead into the waste chute at
        that height, within each printer's rear limits; never a home, and no filament out of the nozzle."""
        moves = printer.toolhead.moves[stopped["moves"]:]
        commands = [command.name.upper() for command in printer.trace[stopped["trace"]:]]
        self.assertEqual([name for name in commands if name.startswith("G28")], [])
        self.assertEqual([move.extrude for move in moves if move.extrude], [])
        x, y, z = stopped["at"]
        if drop:
            self.assertEqual(moves[0].start[:3], (x, y, z))
            self.assertEqual(moves[0].end[:3], (x, y, z + drop))
            moves = moves[1:]
        self.assertTrue(all(move.end[2] == z + drop for move in moves))
        if chute:
            self.assertTrue(all(move.xy_moved for move in moves))
            self.assertTrue(checks.at_chute(printer, moves[-1].end[:2]), moves[-1].end)
        else:
            self.assertEqual(moves, [])
        checks.assert_rear_moves_around_the_chute(self, printer)

    def assert_cools_with_the_fan_until(self, printer):
        """The part fan stays at full until the nozzle is below 170°C, then turns off within the next check."""
        fan = printer.lookup_object("fan_generic cooling_fan")
        extruder = printer.lookup_object("heaters").lookup_heater("extruder")
        self.assertGreaterEqual(extruder.smoothed_temp, FAN_OFF_BELOW)
        while extruder.smoothed_temp >= FAN_OFF_BELOW:
            self.assertEqual(fan.speed, 1.)
            printer.reactor.advance(printer.reactor.monotonic() + .5)
        printer.reactor.advance(printer.reactor.monotonic() + 1.)
        self.assertEqual(fan.speed, 0.)

    def test_stop_turns_the_nozzle_off_and_the_part_fan_on_before_it_parks(self):
        """A stopped print left the nozzle heating at the print's temperature over the print through QIDI's slow lift
        to Z200 (8 mm/s), and turned it off only in PRINT_END, after parking (operator report, 2026-11-24). The nozzle
        has to go off, with the part fan at full to cool it, before the bed drops 20 mm and the toolhead goes to the
        waste chute, and the fan has to stay on until the nozzle is below 170°C, through PRINT_END's M107."""
        for printer_id in FIRMWARE:
            with self.subTest(printer=printer_id):
                printer = self.printer(printer_id)
                stopped = self.stop_while_printing(printer)
                checks.assert_no_errors(self, printer)
                self.assertEqual(printer.status("print_stats")["state"], "cancelled")
                self.assert_parked(printer, stopped, drop=BED_DROP, chute=True)
                lines = [command.line for command in printer.trace[stopped["trace"]:]]
                first_park = next(i for i, line in enumerate(lines) if line.startswith("G1 Z"))
                self.assertLess(lines.index("M104 S0"), first_park)
                self.assertLess(lines.index("M106 S255"), first_park)
                self.assertEqual(printer.status("extruder")["target"], 0.)
                self.assert_cools_with_the_fan_until(printer)

    def test_stop_while_paused_cools_the_nozzle_with_the_part_fan(self):
        """A paused print is stopped as often as a running one. The pause has already turned the nozzle off, but it
        is still hot; the part fan cools it the same way."""
        for printer_id in FIRMWARE:
            for slicer_name in slicer.PACKS:
                with self.subTest(printer=printer_id, slicer=slicer_name):
                    printer = self.printer(printer_id)
                    printer.start_print(slicer.print_with_pause(slicer_name, printer_id).text, nozzle=PRINT_TEMPERATURE)
                    self.assertTrue(printer.status("pause_resume")["is_paused"])
                    printer.command("CANCEL_PRINT")
                    checks.assert_no_errors(self, printer)
                    self.assertEqual(printer.status("print_stats")["state"], "cancelled")
                    self.assertFalse(printer.status("pause_resume")["is_paused"])
                    checks.assert_rear_moves_around_the_chute(self, printer)
                    self.assertTrue(checks.at_chute(printer, printer.toolhead.get_position()[:2]))
                    self.assert_cools_with_the_fan_until(printer)

    def test_stop_drops_the_bed_only_as_far_as_z_travels(self):
        """Near the top of Z's travel the bed drops only to its end, and at the end not at all, and the toolhead still
        goes to the chute."""
        for printer_id in FIRMWARE:
            for below_max in (5., 0.):
                with self.subTest(printer=printer_id, below_max=below_max):
                    printer = self.printer(printer_id)
                    z_max = printer.status("toolhead")["axis_maximum"].z
                    stopped = self.stop_while_printing(printer, z=z_max - below_max)
                    checks.assert_no_errors(self, printer)
                    self.assert_parked(printer, stopped, drop=below_max, chute=True)
                    self.assertEqual(printer.toolhead.get_position()[2], z_max)

    def test_stop_after_a_power_loss_resume_drops_the_bed_and_goes_to_the_chute(self):
        """Plus 5, 2026-11-27: a print resumed after a power loss was cancelled and the nozzle stayed on the print.
        QIDI's resume puts X, Y, and Z back with SET_KINEMATIC_POSITION, which Klipper counts as homed, and homes X
        and Y but never Z, so QIDI's own homed flag stayed 0 and QIDI's park skipped its move. The cancel goes by the
        axes Klipper has homed."""
        lines = two_parts()
        lost_at = sum(len(line) + 1 for line in lines[:5 + WALL_LINES - 20])
        lines.insert(5 + WALL_LINES - 10, "_TEST_STOP")
        for printer_id in FIRMWARE:
            with self.subTest(printer=printer_id):
                printer = self.printer(printer_id)
                stopped = self.register_stop(printer)
                (printer.root / ".cache/job.gcode").write_text("\n".join(lines), encoding="utf-8")
                printer.job_lines = lines
                printer.command("SDCARD_POWER_OFF_CONTINUES_PINT_FILE STATE=%s" % (saved_state(lost_at, []),))

                # The restart lands partway through a line, whose rest Klipper doesn't know as a command.
                restart = "\n".join(lines)[lost_at - 4096:].split("\n")[0]
                printer.unknown_commands = [c for c in printer.unknown_commands if c != restart]
                checks.assert_no_errors(self, printer)
                self.assertEqual(printer.status("print_stats")["state"], "cancelled")
                home_state = printer.lookup_object("gcode_macro _HOME_STATE", None)
                if home_state is not None:
                    self.assertEqual(home_state.variables["is_homed"], 0)
                self.assert_parked(printer, stopped, drop=BED_DROP, chute=True)

    def test_stop_never_homes_and_moves_only_homed_axes(self):
        """A cancel never homes. Without X and Y homed the toolhead stays where it is; without Z homed the bed stays
        and the toolhead goes to the chute at its height, over the print."""
        cases = {"x and y not homed": ("z", BED_DROP, False), "nothing homed": ("", 0., False),
                 "z not homed": ("xy", 0., True)}
        for printer_id in FIRMWARE:
            for case, (homed, drop, chute) in cases.items():
                with self.subTest(printer=printer_id, case=case):
                    printer = self.printer(printer_id)
                    stopped = self.stop_while_printing(printer, homed=set(homed))
                    checks.assert_no_errors(self, printer)
                    self.assertEqual(printer.status("print_stats")["state"], "cancelled")
                    self.assert_parked(printer, stopped, drop=drop, chute=chute)

    def test_a_cold_nozzle_and_a_new_print_keep_their_fan(self):
        """The cooldown is for a hot nozzle only, and must never turn the fan off during the next print or after the
        operator set it."""
        for printer_id in FIRMWARE:
            with self.subTest(printer=printer_id, case="a cold nozzle"):
                printer = self.printer(printer_id)
                self.stop_while_printing(printer, nozzle=FAN_OFF_BELOW - 20.)
                checks.assert_no_errors(self, printer)
                self.assertNotIn("M106 S255", [command.line for command in printer.trace])
                self.assertEqual(printer.lookup_object("fan_generic cooling_fan").speed, 0.)

            with self.subTest(printer=printer_id, case="a new print during the cooldown"):
                printer = self.printer(printer_id)
                self.stop_while_printing(printer)
                fan = printer.lookup_object("fan_generic cooling_fan")
                printer.start_print("G1 X100 Y100 E1 F3000\nM106 S128\nM109 S220\nG1 X120 Y100 E1 F3000\nPAUSE",
                                    nozzle=PRINT_TEMPERATURE)
                printer.reactor.advance(printer.reactor.monotonic() + 300.)
                self.assertAlmostEqual(fan.speed, 128 / 255.)

            for command, speed in (("M107", 0.), ("M106 S100", 100 / 255.)):
                with self.subTest(printer=printer_id, case=f"the operator sends {command}"):
                    printer = self.printer(printer_id)
                    self.stop_while_printing(printer)
                    fan = printer.lookup_object("fan_generic cooling_fan")
                    printer.command(command)
                    printer.reactor.advance(printer.reactor.monotonic() + 300.)
                    self.assertAlmostEqual(fan.speed, speed)


if __name__ == "__main__":
    unittest.main()
