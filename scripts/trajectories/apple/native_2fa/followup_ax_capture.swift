import ApplicationServices
import Cocoa
import CoreGraphics
import Foundation

let env = ProcessInfo.processInfo.environment
let outputFile = env["APPLE_2FA_CODE_FILE"] ?? "/tmp/weles_apple_2fa_code.txt"
let clickAllow = CommandLine.arguments.contains("--click-allow")
let clickDone = CommandLine.arguments.contains("--click-done")
let maxDepth = 12
let pidArgs: [pid_t] = CommandLine.arguments.enumerated().compactMap { index, value in
  guard value == "--pid", CommandLine.arguments.indices.contains(index + 1) else { return nil }
  return pid_t(Int32(CommandLine.arguments[index + 1]) ?? 0)
}.filter { $0 > 0 }

struct CapturedNode {
  let role: String
  let title: String
  let value: String
  let description: String
  let help: String
}

struct Target {
  let pid: pid_t
  let name: String
  let bundle: String
  let source: String
}

func jsonPrint(_ value: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

func number(_ value: Any?) -> Double {
  if let n = value as? NSNumber { return n.doubleValue }
  if let d = value as? Double { return d }
  if let i = value as? Int { return Double(i) }
  return 0
}

func axString(_ element: AXUIElement, _ attr: CFString) -> String {
  var raw: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(element, attr, &raw)
  if err != .success { return "" }
  if let value = raw as? String { return value }
  if let value = raw { return String(describing: value) }
  return ""
}

func axChildren(_ element: AXUIElement, _ attr: CFString) -> [AXUIElement] {
  var raw: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(element, attr, &raw)
  if err != .success { return [] }
  return raw as? [AXUIElement] ?? []
}

func capture(_ element: AXUIElement, depth: Int = 0) -> [(AXUIElement, CapturedNode)] {
  if depth > maxDepth { return [] }
  let node = CapturedNode(
    role: axString(element, kAXRoleAttribute as CFString),
    title: axString(element, kAXTitleAttribute as CFString),
    value: axString(element, kAXValueAttribute as CFString),
    description: axString(element, kAXDescriptionAttribute as CFString),
    help: axString(element, kAXHelpAttribute as CFString)
  )
  var rows: [(AXUIElement, CapturedNode)] = [(element, node)]
  let childAttrs = [
    kAXChildrenAttribute as CFString,
    kAXVisibleChildrenAttribute as CFString,
    kAXWindowsAttribute as CFString,
    kAXContentsAttribute as CFString,
  ]
  for attr in childAttrs {
    for child in axChildren(element, attr) {
      rows.append(contentsOf: capture(child, depth: depth + 1))
    }
  }
  return rows
}

func appInfo(pid: pid_t) -> (String, String) {
  if let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == pid }) {
    return (app.localizedName ?? "", app.bundleIdentifier ?? "")
  }
  return ("", "")
}

func windowServerTargets() -> [Target] {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
  var targets: [Target] = []

  for win in raw {
    let owner = win[kCGWindowOwnerName as String] as? String ?? ""
    let title = win[kCGWindowName as String] as? String ?? ""
    let pid = pid_t((win[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0)
    let layer = (win[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
    let bounds = win[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = number(bounds["Width"])
    let height = number(bounds["Height"])
    let ownerLower = owner.lowercased()
    let titleLower = title.lowercased()

    if pid <= 0 { continue }

    let namedAppleWindow = ownerLower.contains("followup")
      || ownerLower.contains("authentication")
      || ownerLower.contains("securityagent")
      || ownerLower.contains("usernotificationcenter")
      || titleLower.contains("followup")
      || titleLower.contains("authentication")
      || titleLower.contains("apple account")
      || titleLower.contains("apple id")

    let privateFollowUpPrompt = owner.localizedCaseInsensitiveContains("[ App")
      && layer == 25
      && width >= 300
      && width <= 900
      && height >= 200
      && height <= 800

    if !namedAppleWindow && !privateFollowUpPrompt { continue }

    let info = appInfo(pid: pid)
    targets.append(Target(
      pid: pid,
      name: info.0.isEmpty ? owner : info.0,
      bundle: info.1,
      source: "windowserver layer=\(layer) owner=\(owner) title=\(title)"
    ))
  }

  return targets
}

func processTargets() -> [Target] {
  let names = [
    "AuthenticationServicesAgent",
    "CoreServicesUIAgent",
    "SecurityAgent",
    "AppleIDSettings",
    "System Settings",
    "UserNotificationCenter",
    "NotificationCenter",
    "FollowUpUI",
  ]
  if !pidArgs.isEmpty {
    return pidArgs.map { pid in
      let info = appInfo(pid: pid)
      return Target(pid: pid, name: info.0, bundle: info.1, source: "cli")
    }
  }

  let appTargets = NSWorkspace.shared.runningApplications.compactMap { app -> Target? in
    let name = app.localizedName ?? ""
    let bundle = app.bundleIdentifier ?? ""
    let matched = names.contains(name)
      || bundle.contains("AuthenticationServices")
      || bundle.contains("AppleID")
      || bundle.contains("UserNotification")
      || bundle.contains("FollowUp")
    if !matched { return nil }
    return Target(pid: app.processIdentifier, name: name, bundle: bundle, source: "nsworkspace")
  }

  var byPid: [pid_t: Target] = [:]
  for target in appTargets + windowServerTargets() {
    if let existing = byPid[target.pid] {
      byPid[target.pid] = Target(
        pid: target.pid,
        name: existing.name.isEmpty ? target.name : existing.name,
        bundle: existing.bundle.isEmpty ? target.bundle : existing.bundle,
        source: "\(existing.source),\(target.source)"
      )
    } else {
      byPid[target.pid] = target
    }
  }
  return byPid.values.sorted { $0.pid < $1.pid }
}

func isAppleTrustedDevicePrompt(_ text: String) -> Bool {
  let lower = text.lowercased()
  return lower.contains("apple")
    && lower.contains("sign in")
    && lower.contains("allow")
    && lower.contains("do not allow")
}

func extractCode(_ text: String) -> String {
  let lower = text.lowercased()
  if !lower.contains("apple") && !lower.contains("verification") && !lower.contains("sign in") && !lower.contains("code") {
    return ""
  }

  var current = ""
  var best = ""
  for scalar in text.unicodeScalars {
    if CharacterSet.decimalDigits.contains(scalar) {
      current.append(Character(scalar))
      if current.count == 6 {
        best = current
      } else if current.count > 6 {
        current = String(Character(scalar))
      }
    } else if CharacterSet.whitespacesAndNewlines.contains(scalar) || scalar.value == 0x00a0 {
      continue
    } else {
      if current.count != 6 {
        current = ""
      }
    }
  }
  return best
}

func normalizedLabel(_ node: CapturedNode) -> String {
  return [node.title, node.value, node.description, node.help]
    .joined(separator: " ")
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

func pressButton(in rows: [(AXUIElement, CapturedNode)], exactLabels: [String], fallbackNeedles: [String] = []) -> String {
  let buttons = rows.filter { $0.1.role == "AXButton" }
  for (element, node) in buttons {
    let label = normalizedLabel(node)
    if exactLabels.contains(where: { label.caseInsensitiveCompare($0) == .orderedSame }) {
      let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
      return err == .success ? label : ""
    }
  }
  for (element, node) in buttons {
    let label = normalizedLabel(node)
    if label.localizedCaseInsensitiveContains("Do Not Allow") {
      continue
    }
    for needle in fallbackNeedles where label.localizedCaseInsensitiveContains(needle) {
      let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
      return err == .success ? label : ""
    }
  }
  return ""
}

let trusted = AXIsProcessTrusted()
var processSummaries: [[String: Any]] = []
var allText = ""
var clicked: [String] = []

@discardableResult
func captureTargets(pressAllow: Bool, pressDone: Bool) -> String {
  var passText = ""
  for target in processTargets() {
    let root = AXUIElementCreateApplication(target.pid)
    let rows = capture(root)
    let text = rows
      .flatMap { row in [row.1.title, row.1.value, row.1.description, row.1.help] }
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      .joined(separator: "\n")
    allText += "\n" + text
    passText += "\n" + text
    processSummaries.append([
      "pid": target.pid,
      "name": target.name,
      "bundle": target.bundle,
      "source": target.source,
      "nodes": rows.count,
      "textPreview": String(text.prefix(800)),
    ])

    if pressAllow && isAppleTrustedDevicePrompt(text) {
      let label = pressButton(in: rows, exactLabels: ["Allow"], fallbackNeedles: ["Allow"])
      if !label.isEmpty { clicked.append(label) }
    }
    if pressDone && !extractCode(text).isEmpty {
      let label = pressButton(in: rows, exactLabels: ["Done", "OK"])
      if !label.isEmpty { clicked.append(label) }
    }
  }
  return passText
}

if trusted {
  captureTargets(pressAllow: clickAllow, pressDone: clickDone)
}

var code = extractCode(allText)
if code.isEmpty && clicked.contains(where: { $0.caseInsensitiveCompare("Allow") == .orderedSame }) {
  for _ in 0..<50 {
    Thread.sleep(forTimeInterval: 0.2)
    allText = ""
    processSummaries = []
    captureTargets(pressAllow: false, pressDone: clickDone)
    code = extractCode(allText)
    if !code.isEmpty { break }
  }
}

if !code.isEmpty {
  try? "\(code)\n".write(toFile: outputFile, atomically: true, encoding: .utf8)
  try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outputFile)
}

jsonPrint([
  "ok": trusted,
  "accessibilityTrusted": trusted,
  "codeCaptured": !code.isEmpty,
  "outputFile": !code.isEmpty ? outputFile : NSNull(),
  "clicked": clicked,
  "processes": processSummaries,
])
