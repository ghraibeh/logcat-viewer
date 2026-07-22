import SwiftUI

/// MLK Head Unit — an iOS Android Auto **head unit** (receiver). Wireless-only: iOS gives
/// apps no USB-host/AOAP access, so this is the LAN path — advertise + listen on :5288, and
/// the phone (fired at this device's IP by the AA Wireless Helper) projects Android Auto
/// here over the same TLS + AAP protocol the working Android/Electron head units use.
@main
struct HeadUnitApp: App {
    var body: some Scene {
        WindowGroup { HeadUnitScreen() }
    }
}
