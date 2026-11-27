"""A slicer filament change during a print (OrcaSlicer's change of filament at a layer, QIDI Studio's tool change),
on every printer and from both slicer packs, through every branch of QIDI's T_MANAGER (qidi.Vendor.cmd_T_MANAGER):
what the printer does from the change's first line until the print carries on or pauses."""
from __future__ import annotations

import unittest
from dataclasses import dataclass

from installer.tests.gcode_flow import checks, hardware, slicer
from installer.tests.gcode_flow.printer import FIRMWARE, FlowPrinter
from installer.tests.gcode_flow.qidi import BoxSetup

ONE_BOX = dict(boxes=1, current_tool=0)


@dataclass(frozen=True)
class Case:
    name: str
    why: str
    box: BoxSetup
    following: int = 1
    toolhead_filament: bool = True
    cuts: int = 0
    pauses: bool = False
    codes: tuple = ()
    armed: str | None = None


CASES = (
    Case("no Box",
         "QIDI's T_MANAGER does nothing without the Box, so Valve Oil, which hands the cut and the chute move to it, "
         "must still reach the chute before the purge. It didn't, and on the Max 4 the toolhead drove into the back "
         "of the printer and shifted the print (issue #397).",
         BoxSetup()),
    Case("Box off",
         "With Use QIDI Box off, as for an external spool on a Box printer, T_MANAGER does nothing either (#397).",
         BoxSetup(enable_box=0, tools={0: "slot0", 1: "slot1"}, loaded_slot="slot0", **ONE_BOX)),
    Case("another Box slot",
         "QIDI's flow cuts, unloads, and loads; Valve Oil must not cut a second time or purge before the flow is "
         "back at the chute.",
         BoxSetup(enable_box=1, tools={0: "slot0", 1: "slot1"}, loaded_slot="slot0", **ONE_BOX), cuts=1),
    Case("two tools on one slot",
         "T_MANAGER returns at once when both tools map to the same slot; the purge still has to be at the chute.",
         BoxSetup(enable_box=1, tools={0: "slot0", 1: "slot0"}, loaded_slot="slot0", **ONE_BOX)),
    Case("the new tool's slot already loaded",
         "T_MANAGER returns without moving when the new tool's slot is the one loaded, as after a resume reloaded "
         "it; the purge still has to be at the chute.",
         BoxSetup(enable_box=1, tools={0: "slot0", 1: "slot1"}, loaded_slot="slot1", **ONE_BOX), armed="slot1"),
    Case("the new tool's slot at the hub, toolhead empty",
         "T_MANAGER unloads and reloads the slot without cutting; nothing may be pushed out away from the chute.",
         BoxSetup(enable_box=1, tools={0: "slot0", 1: "slot1"}, loaded_slot="slot1", **ONE_BOX),
         toolhead_filament=False),
    Case("a tool with no Box slot",
         "A change to a tool beyond the connected Boxes' slots pauses the print with QDE_004_027 (docs/qidi-box.md); "
         "the pause has to park at the chute, not over the print.",
         BoxSetup(enable_box=1, tools={0: "slot0"}, loaded_slot="slot0", **ONE_BOX), following=5, pauses=True,
         codes=("QDE_004_027",)),
)


class SlicerFilamentChangeTests(checks.FlowTestCase):
    def test_filament_changes_purge_at_the_chute_cut_once_and_carry_on(self):
        filaments = [slicer.Filament(temperature=220)] + [slicer.Filament(temperature=230, range_high=250)] * 5
        for printer_id in FIRMWARE:
            for slicer_name in slicer.PACKS:
                for case in CASES:
                    with self.subTest(printer=printer_id, slicer=slicer_name, case=case.name, why=case.why):
                        printer = FlowPrinter(printer_id, box=case.box, filament_detected=case.toolhead_filament)
                        job = slicer.print_with_change(slicer_name, printer_id, filaments=filaments, current=0,
                                                       following=case.following)
                        printer.start_print(job.text)

                        checks.assert_no_errors(self, printer, case.codes)
                        first = printer.moves_from_line(job.change_line)
                        checks.assert_rear_moves_around_the_chute(self, printer)
                        self.assertEqual(checks.cuts(printer), case.cuts)
                        if case.armed:
                            # T_MANAGER's return re-arms the slot's auto-feed and gears no slot to the extruder.
                            autofeed = printer.vendor.autofeed
                            self.assertEqual(autofeed.bind_stepper, case.armed)
                            self.assertFalse(any(s.extruder_stepper.synced for s in printer.vendor.steppers.values()))
                        if case.pauses:
                            self.assertTrue(printer.status("pause_resume")["is_paused"])
                            self.assertEqual(printer.status("print_stats")["state"], "paused")
                            self.assertTrue(checks.at_chute(printer, printer.toolhead.commanded_pos[:2]))
                            checks.assert_purges_only_at_the_chute(self, printer, first, len(printer.toolhead.moves))
                            continue
                        self.assertEqual(printer.status("print_stats")["state"], "complete")
                        self.assertFalse(printer.status("pause_resume")["is_paused"])
                        checks.assert_purges_only_at_the_chute(
                            self, printer, first, printer.moves_from_line(job.change_line + job.change_lines))
                        state = printer.status("gcode_move")
                        self.assertTrue(state["absolute_coordinates"])
                        self.assertFalse(state["absolute_extrude"])
                        self.assertEqual(printer.toolhead.moves[-1].end[:2],
                                         (job.resume_xy[0] + 5, job.resume_xy[1]))
                        self.assertEqual(printer.status("extruder")["target"], filaments[1].temperature)


class HumidBoxFilamentChangeTests(checks.FlowTestCase):
    def test_a_change_to_moisture_sensitive_filament_in_a_humid_box_warns_and_changes_as_usual(self):
        """A Box at 55 % humidity with PETG in the new tool's slot: vo_box_humidity warns in the console and Fluidd's
        warnings, and the change cuts once, purges at the chute, and the print completes, as with a dry Box. The
        check reads only; it must never hold up, pause, or alter a print's tool change."""
        filaments = [slicer.Filament(temperature=220), slicer.Filament(temperature=230, range_high=250)]
        for printer_id in FIRMWARE:
            with self.subTest(printer=printer_id):
                box = BoxSetup(boxes=1, enable_box=1, tools={0: "slot0", 1: "slot1"}, loaded_slot="slot0",
                               current_tool=0)
                # QIDI's filament list has PETG Basic as ID 39, which earlier firmware saves for the slot.
                printer = FlowPrinter(printer_id, box=box, variables={"filament_slot1": 39})
                printer.objects["aht20_f heater_box1"] = hardware.StatusOnly({"humidity": 55., "temperature": 30.})
                job = slicer.print_with_change("orca", printer_id, filaments=filaments, current=0, following=1)
                printer.start_print(job.text)

                checks.assert_no_errors(self, printer)
                self.assertEqual(printer.status("print_stats")["state"], "complete")
                self.assertEqual(checks.cuts(printer), 1)
                first = printer.moves_from_line(job.change_line)
                checks.assert_purges_only_at_the_chute(
                    self, printer, first, printer.moves_from_line(job.change_line + job.change_lines))
                self.assertTrue(any("Box 1 is at 55 % humidity with PETG Basic (PETG) in 1B" in line
                                    for line in printer.responses.lines))
                warnings = printer.status("vo_printer_warnings")["warnings"]
                self.assertIn("box_humidity_box1", [warning["id"] for warning in warnings])


FAILURES = (
    ("filament caught at the toolhead",
     "Issue #348: QIDI's unload pulled on filament the toolhead held for a minute and a half. Valve Oil stops 20 mm "
     "past the pull-back and pauses the print saying so; once the filament is free, RESUME finishes the change.",
     dict(caught=True), "Something is holding the filament", "caught"),
    ("a Box motor error in the unload",
     "A Box homing timeout raised out of QIDI's unload and the print was cancelled through on_error_gcode (test "
     "printer klippy.log, 2026-11-03). Valve Oil pauses it instead, and RESUME redoes the change.",
     dict(unload_error="Error during homing b_endstop: Communication timeout during homing"),
     "Communication timeout during homing", "unload_error"),
    ("the loaded slot ran out with auto-reload on",
     "QIDI's auto-reload raises AttributeError before switching slots (harness, 2026-11-20; operator klippy.log the "
     "same day). Valve Oil pauses the print naming the slot that ran out, and RESUME loads the new tool's slot.",
     dict(auto_reload_detect=1, inlets=frozenset({"slot1"})), "1A ran out of filament", None),
)


class FailedFilamentChangeTests(checks.FlowTestCase):
    def test_a_change_that_fails_pauses_the_print_and_resume_finishes_it(self):
        filaments = [slicer.Filament(temperature=220), slicer.Filament(temperature=230, range_high=250)]
        for printer_id in FIRMWARE:
            for name, why, fault, message, cleared in FAILURES:
                with self.subTest(printer=printer_id, case=name, why=why):
                    box = BoxSetup(boxes=1, enable_box=1, tools={0: "slot0", 1: "slot1"}, loaded_slot="slot0",
                                   current_tool=0, **fault)
                    printer = FlowPrinter(printer_id, box=box)
                    job = slicer.print_with_change("orca", printer_id, filaments=filaments, current=0, following=1)
                    printer.start_print(job.text)

                    self.assertFalse(printer.is_shutdown(), printer.shutdown_message)
                    self.assertEqual(printer.status("print_stats")["state"], "paused")
                    self.assertEqual(len(printer.responses.errors), 1)
                    self.assertIn(message, printer.responses.errors[0])
                    self.assertTrue(checks.at_chute(printer, printer.toolhead.commanded_pos[:2]))
                    first = printer.moves_from_line(job.change_line)
                    checks.assert_purges_only_at_the_chute(self, printer, first, len(printer.toolhead.moves))

                    if cleared:
                        setattr(printer.vendor, cleared, None)
                    printer.responses.lines.clear()
                    printer.command("RESUME")
                    checks.assert_no_errors(self, printer)
                    self.assertEqual(printer.status("print_stats")["state"], "complete")
                    self.assertEqual(printer.variables()["last_load_slot"], "slot1")
                    checks.assert_purges_only_at_the_chute(
                        self, printer, first, printer.moves_from_line(job.change_line + job.change_lines))
                    checks.assert_rear_moves_around_the_chute(self, printer)
                    self.assertEqual(printer.toolhead.moves[-1].end[:2], (job.resume_xy[0] + 5, job.resume_xy[1]))


# Where a part after the change sits so that a diagonal from each printer's chute would leave its rear limits.
BEYOND_A_DIAGONAL = {"max4": (330., 390.), "plus5": (20., 300.), "smart5": (165., 120.)}
SAME_SLOT = dict(boxes=1, enable_box=1, tools={0: "slot0", 1: "slot0"}, loaded_slot="slot0", current_tool=0)


class SameSlotChangeExitTests(checks.FlowTestCase):
    """A change between two tools on one Box slot parks at the chute and QIDI drops every move until
    TOOL_CHANGE_END, the pack's straight exit from the chute among them; Valve Oil leaves the chute straight forward
    at the print's next travel instead, without upsetting Klipper's cancelled parts."""

    def job(self, printer_id, *, pause=False, cancel_next=False):
        filaments = [slicer.Filament(temperature=220), slicer.Filament(temperature=230, range_high=250)]
        # With cancel_next, the change's own part is cancelled too, so Klipper has learned the extruder's position
        # by then and drops all of part_2.
        lines = slicer.print_with_change("orca", printer_id, filaments=filaments, current=0, following=1,
                                         cancelled=cancel_next).text.splitlines()
        x, y = BEYOND_A_DIAGONAL[printer_id]
        if cancel_next:
            lines.insert(2, "EXCLUDE_OBJECT NAME=part_2")
        lines.insert(0, f"EXCLUDE_OBJECT_DEFINE NAME=part_3 CENTER={x:g},{y:g} "
                        f"POLYGON=[[{x - 1:g},{y - 1:g}],[{x + 1:g},{y - 1:g}],[{x + 1:g},{y:g}],[{x - 1:g},{y:g}]]")
        if pause:
            end = lines.index("TOOL_CHANGE_END")
            lines.insert(end + 1, "PAUSE")
        lines += ["EXCLUDE_OBJECT_START NAME=part_3", f"G1 X{x - 1:g} Y{y:g} F12000", "G1 Z0.2 F600",
                  "G1 E0.8 F2100", f"G1 X{x:g} Y{y:g} E0.25 F3000", "EXCLUDE_OBJECT_END NAME=part_3"]
        return "\n".join(lines), (x, y)

    def test_the_next_travel_leaves_the_chute_straight_even_past_a_cancelled_part(self):
        """With the part after the change cancelled, Klipper drops its travel and the exit came with it, so the
        toolhead crossed from the chute to the next part diagonally (review, 2026-11-23)."""
        for printer_id in FIRMWARE:
            for cancel_next in (False, True):
                with self.subTest(printer=printer_id, next_part_cancelled=cancel_next):
                    printer = FlowPrinter(printer_id, box=BoxSetup(**SAME_SLOT))
                    text, part_3 = self.job(printer_id, cancel_next=cancel_next)
                    printer.start_print(text)
                    checks.assert_no_errors(self, printer)
                    self.assertEqual(printer.status("print_stats")["state"], "complete")
                    checks.assert_rear_moves_around_the_chute(self, printer)
                    self.assertEqual(printer.toolhead.moves[-1].end[:2], part_3)
                    if cancel_next:
                        # part_2 prints at X155 Y150.
                        self.assertNotIn((155., 150.), [m.end[:2] for m in printer.toolhead.moves if m.extrude > 0])

    def test_a_part_cancelled_while_paused_after_the_change_stays_cancelled(self):
        """A one-shot transform put on top at TOOL_CHANGE_END took Klipper's cancelled-part transform out of the chain
        when a part was first cancelled while it waited, and the cancelled part printed after RESUME (review,
        2026-11-23)."""
        for printer_id in FIRMWARE:
            with self.subTest(printer=printer_id):
                printer = FlowPrinter(printer_id, box=BoxSetup(**SAME_SLOT))
                text, part_3 = self.job(printer_id, pause=True)
                printer.start_print(text)
                self.assertEqual(printer.status("print_stats")["state"], "paused")
                printer.command("EXCLUDE_OBJECT NAME=part_2")
                printer.command("RESUME")
                printer.reactor.advance(printer.reactor.monotonic())
                checks.assert_no_errors(self, printer)
                self.assertEqual(printer.status("print_stats")["state"], "complete")
                checks.assert_rear_moves_around_the_chute(self, printer)
                # part_2 prints at X155 Y150; part_3 still prints.
                self.assertEqual([m.end[:2] for m in printer.toolhead.moves if m.extrude > 0 and m.xy_moved
                                  and m.end[:2] == (155., 150.)], [])
                self.assertEqual(printer.toolhead.moves[-1].end[:2], part_3)


class CancelledPartFilamentChangeTests(checks.FlowTestCase):
    def test_a_change_inside_a_cancelled_part_still_cuts_unloads_and_loads(self):
        """Klipper drops every move inside a cancelled part, extruder moves too, and OrcaSlicer writes a filament
        change inside the label of the part printed just before it. After an operator cancelled a part, its change
        ran without the toolhead: no cut, an unload that stopped with filament at the toolhead, and a paused print
        whose retracts did nothing (Max 4, 26.11.20.1, 2026-11-22). Valve Oil lets the change's moves through, first
        raising the nozzle to where the change expects it, while the cancelled part's own moves stay dropped."""
        filaments = [slicer.Filament(temperature=220), slicer.Filament(temperature=230, range_high=250)]
        for printer_id in FIRMWARE:
            with self.subTest(printer=printer_id):
                box = BoxSetup(boxes=1, enable_box=1, tools={0: "slot0", 1: "slot1"}, loaded_slot="slot0",
                               current_tool=0)
                printer = FlowPrinter(printer_id, box=box)
                job = slicer.print_with_change("orca", printer_id, filaments=filaments, current=0, following=1,
                                               cancelled=True)
                printer.start_print(job.text)
                checks.assert_no_errors(self, printer)
                self.assertEqual(printer.status("print_stats")["state"], "complete")
                self.assertEqual(checks.cuts(printer), 1)
                self.assertEqual(printer.variables()["last_load_slot"], "slot1")
                first = printer.moves_from_line(job.change_line)
                resumed = printer.moves_from_line(job.change_line + job.change_lines)
                checks.assert_purges_only_at_the_chute(self, printer, first, resumed)
                purged = sum(out for move, out in list(checks.pushed_out(printer.toolhead.moves))[first:resumed])
                self.assertGreater(purged, 0.)
                self.assertEqual(printer.toolhead.moves[-1].end[:2], (job.resume_xy[0] + 5, job.resume_xy[1]))
                # The cancelled part's moves after Klipper's five learning extrusions are dropped.
                part_moves = printer.toolhead.moves[:first]
                self.assertEqual([m for m in part_moves if m.end[:3] == (*job.resume_xy, 2.) and m.extrude > 0], [])
                lift = printer.toolhead.moves[first]
                self.assertEqual(lift.start[:2], lift.end[:2])
                self.assertGreaterEqual(lift.end[2], 5.)

    def test_a_cancelled_part_stays_cancelled_after_a_change_that_never_ends(self):
        """Valve Oil lets moves through a cancelled part from TOOL_CHANGE_START until TOOL_CHANGE_END. When the end
        never comes, the cancelled part would print, in the air, for the rest of the print or into the next one. The
        part's next label ends the change (G-code that starts a change without ending it, such as an operator's own
        change G-code), and so does a new print (a print cancelled while paused in a failed change)."""
        defined = ["EXCLUDE_OBJECT_DEFINE NAME=part_1 CENTER=45,80 POLYGON=[[40,70],[50,70],[50,90],[40,90]]",
                   "EXCLUDE_OBJECT_DEFINE NAME=part_2 CENTER=125,80 POLYGON=[[120,70],[130,70],[130,90],[120,90]]"]

        def part(name, x, moves):
            return [f"EXCLUDE_OBJECT_START NAME={name}", *(f"G1 X{x + i} Y80 E0.2 F3000" for i in range(moves)),
                    f"EXCLUDE_OBJECT_END NAME={name}"]
        # part_2's six extrusions first, while Klipper learns the extruder's position.
        relabelled = "\n".join(defined + ["EXCLUDE_OBJECT NAME=part_1"] + part("part_2", 120, 6) + [
            "EXCLUDE_OBJECT_START NAME=part_1", "TOOL_CHANGE_START F=0 T=1", "EXCLUDE_OBJECT_END NAME=part_1"]
            + part("part_1", 40, 6) + part("part_2", 126, 1))
        filaments = [slicer.Filament(temperature=220), slicer.Filament(temperature=230, range_high=250)]
        for printer_id in FIRMWARE:
            with self.subTest(printer=printer_id, case="the part's next label"):
                printer = FlowPrinter(printer_id, box=BoxSetup())
                printer.start_print(relabelled, at=(120., 80., 2.))
                checks.assert_no_errors(self, printer)
                self.assertEqual(printer.status("print_stats")["state"], "complete")
                printed = [m.end[:2] for m in printer.toolhead.moves if m.extrude > 0]
                self.assertEqual([xy for xy in printed if xy[0] < 90], [])
                self.assertEqual(printed[-1], (126., 80.))

            with self.subTest(printer=printer_id, case="a new print"):
                box = BoxSetup(boxes=1, enable_box=1, tools={0: "slot0", 1: "slot1"}, loaded_slot="slot0",
                               current_tool=0, caught=True)
                printer = FlowPrinter(printer_id, box=box)
                job = slicer.print_with_change("orca", printer_id, filaments=filaments, current=0, following=1,
                                               cancelled=True)
                printer.start_print(job.text)
                self.assertEqual(printer.status("print_stats")["state"], "paused")
                printer.command("CANCEL_PRINT")
                self.assertEqual(printer.status("print_stats")["state"], "cancelled")
                printer.responses.lines.clear()
                printer.vendor.caught = False

                printer.start_print("\n".join(defined + ["EXCLUDE_OBJECT NAME=part_1"] + part("part_2", 120, 6)
                                              + part("part_1", 40, 6) + part("part_2", 126, 1)), at=(120., 80., 2.))
                checks.assert_no_errors(self, printer)
                self.assertEqual(printer.status("print_stats")["state"], "complete")
                printed = [m.end[:2] for m in printer.toolhead.moves if m.extrude > 0]
                self.assertEqual([xy for xy in printed if xy[0] < 90], [])
                self.assertEqual(printed[-1], (126., 80.))


if __name__ == "__main__":
    unittest.main()
