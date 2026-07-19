pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "MobileLabKit HeadUnit"
include(":app")
// Companion "Wireless Helper" app — installed on the SOURCE PHONE (the one with Android
// Auto). It fires Google's WirelessStartupActivity/Receiver trigger so AA connects to our
// head unit's TCP :5288 over the shared Wi-Fi. (Same role as headunit-revived's "Wireless
// Helper" mode — stock AA has no head-unit-side trigger; something must run on the phone.)
include(":helper")
