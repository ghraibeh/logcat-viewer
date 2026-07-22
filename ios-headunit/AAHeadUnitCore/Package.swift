// swift-tools-version:5.9
import PackageDescription

// Platform-agnostic core of the iOS Android Auto head unit. The transport framing and the
// in-memory TLS engine are pure Foundation/Security — they build + test on macOS, which is
// how we de-risk the iOS-specific unknowns before wiring the UIKit app (video/audio/touch)
// and the protobuf channel layer around them.
let package = Package(
    name: "AAHeadUnitCore",
    platforms: [.macOS(.v12), .iOS(.v16)],
    products: [
        .library(name: "AAHeadUnitCore", targets: ["AAHeadUnitCore"]),
    ],
    targets: [
        .target(name: "AAHeadUnitCore"),
        .testTarget(name: "AAHeadUnitCoreTests", dependencies: ["AAHeadUnitCore"]),
    ]
)
