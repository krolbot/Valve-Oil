"""The RGB light's effects (VO_LIGHT_EFFECT), which Valve Oil UI's Fans and lights card and slicer G-code set, on
every printer."""
from __future__ import annotations

import unittest

from installer.tests.gcode_flow import checks
from installer.tests.gcode_flow.printer import FIRMWARE, FlowPrinter
from installer.tests.gcode_flow.qidi import BoxSetup


class LightEffectTests(checks.FlowTestCase):
    def light_commands(self, printer, script):
        printer.trace.clear()
        printer.command(script)
        return [command.line for command in printer.trace if command.name.startswith("NEOPIXEL_")]

    def effect(self, printer):
        return printer.status("gcode_macro VO_LIGHT_EFFECT")

    def test_an_effect_stops_qidis_status_light_first_and_status_hands_it_back(self):
        """QIDI's status light changes the light at every print start, pause, and end, so an effect it isn't told to
        stop for lasts only until the next print. The card shows the macro's variables, because QIDI's module doesn't
        report the effect running on the main board, so they have to follow what was sent."""
        for printer_id in FIRMWARE:
            with self.subTest(printer=printer_id):
                printer = FlowPrinter(printer_id, box=BoxSetup())
                self.assertEqual(self.effect(printer)["effect"], "status")
                lines = self.light_commands(printer, "VO_LIGHT_EFFECT EFFECT=comet RED=0 GREEN=128 BLUE=255 BRIGHTNESS=50 SPEED=fast DIRECTION=0")
                self.assertEqual(lines, ["NEOPIXEL_ENABLE ENABLE=0", "NEOPIXEL_MODE M=6 RED=0 GREEN=64 BLUE=128 DIR=0 PERIOD=750 TICK=30"])
                state = self.effect(printer)
                self.assertEqual((state["effect"], state["red"], state["green"], state["blue"], state["brightness"], state["speed"], state["direction"]),
                                 ("comet", 0, 128, 255, 50, "fast", 0))

                # Off, then on again, comes back to the same effect; the color and speed are kept.
                self.assertEqual(self.light_commands(printer, "VO_LIGHT_EFFECT EFFECT=off"), ["NEOPIXEL_ENABLE ENABLE=0"])
                self.assertEqual(self.effect(printer)["effect"], "off")
                self.assertEqual(self.light_commands(printer, "VO_LIGHT_EFFECT EFFECT=on")[-1], "NEOPIXEL_MODE M=6 RED=0 GREEN=64 BLUE=128 DIR=0 PERIOD=750 TICK=30")

                # Rainbow makes its own colors; solid has no period.
                self.assertEqual(self.light_commands(printer, "VO_LIGHT_EFFECT EFFECT=rainbow BRIGHTNESS=100 SPEED=normal")[-1], "NEOPIXEL_MODE M=4 RED=255 GREEN=255 BLUE=255 DIR=0 PERIOD=6000 TICK=40")
                self.assertEqual(self.light_commands(printer, "VO_LIGHT_EFFECT EFFECT=solid")[-1], "NEOPIXEL_MODE M=1 RED=0 GREEN=128 BLUE=255 DIR=0")

                self.assertEqual(self.light_commands(printer, "VO_LIGHT_EFFECT EFFECT=status"), ["NEOPIXEL_ENABLE ENABLE=1"])
                self.assertEqual(self.effect(printer)["effect"], "status")
                checks.assert_no_errors(self, printer)

    def test_an_unknown_effect_or_speed_sends_nothing(self):
        """A typo in slicer G-code shouldn't turn the light off or leave the card showing an effect that isn't
        running."""
        printer = FlowPrinter("max4", box=BoxSetup())
        for script in ("VO_LIGHT_EFFECT EFFECT=disco", "VO_LIGHT_EFFECT EFFECT=comet SPEED=warp"):
            with self.subTest(script=script):
                printer.trace.clear()
                with self.assertRaises(Exception):
                    printer.run(script)
                self.assertFalse([command for command in printer.trace if command.name.startswith("NEOPIXEL_")])
                self.assertEqual(self.effect(printer)["effect"], "status")


if __name__ == "__main__":
    unittest.main()
