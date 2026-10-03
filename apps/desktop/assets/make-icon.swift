// Generates the smolcoder-plus app icon: black "S+" on white.
// Usage: swiftc -O -o make-icon make-icon.swift && ./make-icon icon-1024.png
// (macOS only; needs AppKit + Menlo.)
import AppKit
import Foundation

let size = 1024
let out = CommandLine.arguments.dropFirst().first ?? "icon-1024.png"

let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = ctx
ctx.imageInterpolation = .high
ctx.shouldAntialias = true

// Full-bleed white; macOS masks the squircle at install/display time.
NSColor.white.setFill()
NSBezierPath.fill(NSRect(x: 0, y: 0, width: size, height: size))

let font = NSFont(name: "Menlo-Bold", size: 600) ?? NSFont.boldSystemFont(ofSize: 600)
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
let str = NSAttributedString(string: "S+", attributes: attrs)
let ts = str.size()
// Optical centering: the + rides high, so the block sits a touch low.
let pt = NSPoint(x: (CGFloat(size) - ts.width) / 2, y: (CGFloat(size) - ts.height) / 2 - 24)
str.draw(at: pt)

NSGraphicsContext.restoreGraphicsState()
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
