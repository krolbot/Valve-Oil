# QIDI Box humidity for Valve Oil.
#
# Each QIDI Box reports the humidity and temperature of its air through
# QIDI's AHT20 sensor (`aht20_f heater_box<N>`). QIDI's Box card colors the
# humidity (below 40 % normal, below 60 % high, above that too high), but
# nothing acted on it.
#
# When a print takes a Box slot, at QIDI's Box print start
# (BOX_PRINT_START EXTRUDER=<tool>) and at each tool change
# (T_MANAGER T=<tool>, which T0-T15 call), the tool is mapped to its slot as
# QIDI maps it (value_t<tool>, else slot<tool>). If the slot's filament type
# takes up moisture (SENSITIVE_TYPES, by the type QIDI's filament list gives
# it) and its Box's humidity is at or above the warning level, the console
# says so and a printer warning names the Box, the slot, the filament, and
# the humidity. Klipper never sees the file's filament list (Moonraker reads
# that from the file), so slots are checked as QIDI's print start and tool
# changes take them. The check only reads: the command then runs as it would
# without Valve Oil, and nothing waits, pauses, or stops for it. A warning
# stays until the next print starts, its Box's humidity falls below the
# warning level, or the check is turned off.
#
# Saved variables:
#   vo_box_humidity_warning    1 (default) checks at print start, 0 doesn't
#   vo_box_humidity_threshold  warning level in % RH, from 10 to 90
#                              (default 40, QIDI's own "normal" limit)
#
# VO_BOX_HUMIDITY prints each Box's humidity, temperature, how long it has
# been at or above the warning level, and the settings. The same is in this
# module's status for Valve Oil UI, refreshed every CHECK_TIME seconds.
#
# It never starts QIDI's Box drying itself.

import logging
import os
import re

WARNING_VARIABLE = "vo_box_humidity_warning"
THRESHOLD_VARIABLE = "vo_box_humidity_threshold"
DEFAULT_THRESHOLD = 40.
MIN_THRESHOLD = 10.
MAX_THRESHOLD = 90.
CHECK_TIME = 5.
MAX_BOXES = 4
SLOTS_PER_BOX = 4
SLOT_LETTERS = "ABCD"
FILAMENT_LIST = "officiall_filas_list.cfg"
PRINT_STATES = ("printing", "paused", "extracting")
# QIDI's print start and tool change, and the parameter naming the tool.
TOOL_COMMANDS = (("BOX_PRINT_START", "EXTRUDER"), ("T_MANAGER", "T"))
# Filament types that take up moisture from the air, by the part of QIDI's
# type before its first dash or space: PETG-CF counts as PETG, PA12-CF as
# PA12, TPU-AERO 64D as TPU, PC-ABS-FR as PC.
SENSITIVE_TYPES = frozenset((
    "PA", "PA6", "PA11", "PA12", "PAHT", "PPA", "ULTRAPA",
    "PET", "PETG",
    "TPU", "TPE", "TPEE", "PEBA",
    "PVA", "BVOH",
    "PC",
    "PPS",
))


def slot_label(slot):
    """Name a slot the way the QIDI Box card does: slot 5 is 2B."""
    return "%d%s" % (slot // SLOTS_PER_BOX + 1, SLOT_LETTERS[slot % SLOTS_PER_BOX])


def type_family(filament_type):
    """The part of a filament type before its first dash or space."""
    words = re.split(r"[\s\-+/]+", str(filament_type or "").strip().upper())
    return words[0] if words else ""


def moisture_sensitive(filament_type):
    return type_family(filament_type) in SENSITIVE_TYPES


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _text(value):
    if value is None:
        return ""
    return str(value).strip().strip("'\"").strip()


def _join(items):
    if len(items) < 3:
        return " and ".join(items)
    return ", ".join(items[:-1]) + ", and " + items[-1]


class BoxHumidity:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.reactor = self.printer.get_reactor()
        self.gcode = self.printer.lookup_object("gcode")
        config_file = self.printer.get_start_args().get("config_file")
        self.list_path = (os.path.join(os.path.dirname(config_file),
                                       FILAMENT_LIST)
                          if config_file else None)
        self.list_stamp = None
        self.list_sections = {}
        self.in_print = False
        self.checked = set()
        self.alerts = {}
        self.humid_since = {}
        self.status = {"warning_enabled": True,
                       "threshold": DEFAULT_THRESHOLD,
                       "boxes": [], "alerts": []}
        self.gcode.register_command(
            "VO_BOX_HUMIDITY", self.cmd_VO_BOX_HUMIDITY,
            desc="Shows each QIDI Box's humidity and the humidity warning "
                 "settings")
        self.printer.register_event_handler("klippy:ready", self._ready)

    def _ready(self):
        wrapped = []
        for name, param in TOOL_COMMANDS:
            original = self.gcode.register_command(name, None)
            if original is None:
                continue
            self.gcode.register_command(
                name, self._watch(name, param, original),
                desc=self.gcode.gcode_help.get(name))
            wrapped.append(name)
        self.reactor.register_timer(self._tick, self.reactor.NOW)
        logging.info("vo_box_humidity: active; checks slots at %s",
                     ", ".join(wrapped) or "nothing (no QIDI Box commands)")

    def _watch(self, name, param, original):
        def handler(gcmd):
            try:
                self._take(gcmd.get(param, None),
                           new_print=name == "BOX_PRINT_START")
            except Exception:
                logging.exception("vo_box_humidity: check at %s failed", name)
            return original(gcmd)
        return handler

    def _variables(self):
        return getattr(self.printer.lookup_object("save_variables", None),
                       "allVariables", None) or {}

    def warning_enabled(self):
        value = self._variables().get(WARNING_VARIABLE, 1)
        number = _number(value)
        return bool(value) if number is None else number != 0.

    def threshold(self):
        value = _number(self._variables().get(THRESHOLD_VARIABLE))
        if value is None or not MIN_THRESHOLD <= value <= MAX_THRESHOLD:
            return DEFAULT_THRESHOLD
        return value

    def _status(self, name, eventtime):
        obj = self.printer.lookup_object(name, None)
        if obj is None or not hasattr(obj, "get_status"):
            return {}
        status = obj.get_status(eventtime)
        return status if hasattr(status, "get") else {}

    def _printing(self, eventtime):
        if self._status("print_stats", eventtime).get("state") in PRINT_STATES:
            return True
        sd = self.printer.lookup_object("virtual_sdcard", None)
        return sd is not None and bool(sd.is_active())

    def _reading(self, box, eventtime):
        """(humidity, temperature) of a Box, None for a value it doesn't
        give; None when the Box has no humidity sensor."""
        name = "aht20_f heater_box%d" % box
        if self.printer.lookup_object(name, None) is None:
            return None
        status = self._status(name, eventtime)
        humidity = _number(status.get("humidity"))
        if humidity is not None and not 0. <= humidity <= 100.:
            humidity = None
        return humidity, _number(status.get("temperature"))

    def _drying(self, box, eventtime):
        boxes = self._status("box_extras", eventtime).get("boxes")
        return isinstance(boxes, list) and box <= len(boxes) \
            and hasattr(boxes[box - 1], "get") \
            and boxes[box - 1].get("dry_state") == 1

    def _tool_slot(self, tool):
        """The Box slot QIDI loads for a tool, or None for the external
        spool or a slot on no connected Box."""
        variables = self._variables()
        match = re.match(r"^slot(\d+)$",
                         _text(variables.get("value_t%d" % tool))
                         or "slot%d" % tool)
        box_count = _number(variables.get("box_count")) or 0.
        if match is None:
            return None
        slot = int(match.group(1))
        if slot >= min(int(box_count) * SLOTS_PER_BOX,
                       MAX_BOXES * SLOTS_PER_BOX):
            return None
        return slot

    def _filament_list(self):
        """QIDI's officiall_filas_list.cfg as {section: {key: value}}, read
        again when it changes."""
        try:
            info = os.stat(self.list_path)
            stamp = (info.st_mtime_ns, info.st_size)
        except (OSError, TypeError):
            return {}
        if stamp != self.list_stamp:
            sections, section = {}, None
            try:
                with open(self.list_path, encoding="utf-8",
                          errors="replace") as handle:
                    for raw in handle:
                        line = raw.strip()
                        if not line or line.startswith(("#", ";")):
                            continue
                        header = re.match(r"^\[(.+)\]$", line)
                        if header:
                            section = sections.setdefault(
                                header.group(1).strip(), {})
                        elif section is not None and "=" in line:
                            key, value = line.split("=", 1)
                            section[key.strip()] = _text(value)
            except OSError:
                return {}
            self.list_stamp, self.list_sections = stamp, sections
        return self.list_sections

    def _filament(self, slot, eventtime):
        """{"type", "name"} of the filament QIDI has for a slot, or None."""
        boxes = self._status("box_extras", eventtime).get("boxes")
        box = slot // SLOTS_PER_BOX
        infos = boxes[box].get("filament_info") if isinstance(boxes, list) \
            and box < len(boxes) and hasattr(boxes[box], "get") else None
        if isinstance(infos, list):
            # QIDI firmware that resolves each slot's filament (Max 4
            # 01.01.07.01 on).
            index = slot % SLOTS_PER_BOX
            found = [info for info in infos if hasattr(info, "get")
                     and info.get("index") == index]
            info = found[0] if found else (
                infos[index] if index < len(infos) else None)
            if not hasattr(info, "get"):
                return None
            kind = _text(info.get("filament_type"))
            name = " ".join(part for part in (_text(info.get("vendor_str")),
                                              _text(info.get("filament_str")))
                            if part)
            return {"type": kind, "name": name or kind} if kind else None
        # Earlier firmware saves a numeric ID from QIDI's filament list.
        filament_id = _text(self._variables().get("filament_slot%d" % slot))
        entry = self._filament_list().get("fila" + filament_id) \
            if filament_id.isdigit() else None
        if not entry or not entry.get("type"):
            return None
        return {"type": entry["type"],
                "name": entry.get("filament") or entry["type"]}

    def _take(self, tool, new_print):
        eventtime = self.reactor.monotonic()
        if new_print or not self.in_print:
            self.checked = set()
            self.alerts = {}
            self.in_print = True
            self._publish(eventtime)
        if not self.warning_enabled():
            return
        try:
            slot = self._tool_slot(int(_text(tool)))
        except ValueError:
            return
        if slot is None or slot in self.checked:
            return
        self.checked.add(slot)
        alert = self._alert(slot, eventtime)
        if alert is None:
            return
        self.alerts[slot] = alert
        message = ("Box %d is at %.0f %% humidity with %s (%s) in %s, at or "
                   "above the %.0f %% warning level. %s takes up moisture, "
                   "which can cause stringing, bubbles, and weak parts. The "
                   "print goes on; dry the filament before printing it "
                   "again." % (alert["box"], alert["humidity"],
                               alert["filament"], alert["type"],
                               alert["slot"], self.threshold(),
                               alert["type"]))
        logging.info("vo_box_humidity: %s", message)
        self.gcode.respond_info(message)
        self._publish(eventtime)

    def _alert(self, slot, eventtime):
        box = slot // SLOTS_PER_BOX + 1
        reading = self._reading(box, eventtime)
        if reading is None or reading[0] is None \
                or reading[0] < self.threshold():
            return None
        filament = self._filament(slot, eventtime)
        if filament is None or not moisture_sensitive(filament["type"]):
            return None
        return {"box": box, "slot": slot_label(slot),
                "filament": filament["name"], "type": filament["type"],
                "humidity": round(reading[0])}

    def printer_warnings(self):
        """A printer warning for each Box with a slot the last print took
        while that Box was too humid for its filament."""
        warnings = []
        for box in sorted(set(alert["box"] for alert in self.alerts.values())):
            alerts = [alert for slot, alert in sorted(self.alerts.items())
                      if alert["box"] == box]
            types = []
            for alert in alerts:
                if alert["type"] not in types:
                    types.append(alert["type"])
            warnings.append({
                "id": "box_humidity_box%d" % box,
                "level": "warning",
                "title": "Box %d is too humid for its filament." % box,
                "message": "Box %d was at %d %% humidity, at or above the "
                           "%.0f %% warning level, when the print took %s. "
                           "%s %s up moisture, which can cause "
                           "stringing, bubbles, and weak parts. Dry the "
                           "filament before printing it again."
                           % (box, max(alert["humidity"] for alert in alerts),
                              self.threshold(),
                              _join(["%s (%s)" % (alert["slot"],
                                                  alert["filament"])
                                     for alert in alerts]),
                              _join(types),
                              "takes" if len(types) == 1 else "take"),
            })
        return warnings

    def _tick(self, eventtime):
        if self.printer.is_shutdown():
            return self.reactor.NEVER
        try:
            self._refresh(eventtime)
        except Exception:
            logging.exception("vo_box_humidity: refresh failed")
        return eventtime + CHECK_TIME

    def _refresh(self, eventtime):
        if not self._printing(eventtime):
            self.in_print = False
        threshold = self.threshold()
        humid = {}
        for box in range(1, MAX_BOXES + 1):
            reading = self._reading(box, eventtime)
            if reading is None or reading[0] is None \
                    or reading[0] < threshold:
                self.humid_since.pop(box, None)
            else:
                self.humid_since.setdefault(box, eventtime)
            humid[box] = reading
        if not self.warning_enabled():
            self.alerts = {}
        for slot, alert in list(self.alerts.items()):
            reading = humid.get(alert["box"])
            if reading is None or reading[0] is None \
                    or reading[0] < threshold:
                del self.alerts[slot]
        self._publish(eventtime, humid)

    def _publish(self, eventtime, readings=None):
        boxes = []
        for box in range(1, MAX_BOXES + 1):
            reading = (readings.get(box) if readings is not None
                       else self._reading(box, eventtime))
            if reading is None:
                continue
            humidity, temperature = reading
            since = self.humid_since.get(box)
            boxes.append({
                "box": box,
                "humidity": None if humidity is None else round(humidity),
                "temperature": None if temperature is None
                else round(temperature, 1),
                "humid": since is not None,
                "humid_minutes": None if since is None
                else int((eventtime - since) // 60.),
                "drying": self._drying(box, eventtime),
            })
        self.status = {
            "warning_enabled": self.warning_enabled(),
            "threshold": self.threshold(),
            "boxes": boxes,
            "alerts": [dict(alert) for slot, alert in
                       sorted(self.alerts.items())],
        }

    def cmd_VO_BOX_HUMIDITY(self, gcmd):
        eventtime = self.reactor.monotonic()
        self._refresh(eventtime)
        status = self.status
        lines = []
        for box in status["boxes"]:
            parts = ["unknown humidity" if box["humidity"] is None
                     else "%d %% humidity" % box["humidity"]]
            if box["temperature"] is not None:
                parts.append("%.1f °C" % box["temperature"])
            if box["humid"]:
                parts.append("at or above the warning level for %d min"
                             % box["humid_minutes"])
            if box["drying"]:
                parts.append("drying")
            lines.append("Box %d: %s" % (box["box"], ", ".join(parts)))
        if not lines:
            lines.append("No QIDI Box humidity sensor found.")
        lines.append("Warning level: %.0f %% (%s)."
                     % (status["threshold"], THRESHOLD_VARIABLE))
        lines.append("Humidity check at print start: %s (%s)."
                     % ("on" if status["warning_enabled"] else "off",
                        WARNING_VARIABLE))
        for alert in status["alerts"]:
            lines.append("Warning: %s, %s (%s), at %d %%."
                         % (alert["slot"], alert["filament"], alert["type"],
                            alert["humidity"]))
        gcmd.respond_info("\n".join(lines))

    def get_status(self, eventtime=None):
        return self.status


def load_config(config):
    return BoxHumidity(config)
