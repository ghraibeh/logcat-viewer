plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mobilelabkit.chromecast"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mobilelabkit.chromecast"
        minSdk = 26                 // NsdManager TXT attrs + AndroidKeyStore self-signed cert + adaptive icons
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    // Phase 1 is pure Kotlin (discovery + TLS capture) — no native lib yet. The Cast
    // protocol/auth/streaming core (vendored openscreen) lands in Phase 2 as an
    // externalNativeBuild, mirroring android-airplay's cpp/ + deps/ layout.

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Intentionally none — plain android.app.Activity + platform NsdManager / MediaCodec /
    // javax.net.ssl, matching android-airplay's dependency-light ethos.
}
