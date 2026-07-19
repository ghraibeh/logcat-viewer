plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mobilelabkit.headunit"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mobilelabkit.headunit"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }

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
    // Phase 1 is pure Android USB Host API + platform TLS/MediaCodec — no third-party deps.
    // Phase 2 adds protobuf-javalite (compiled from the aasdk .proto in src/main/proto).
}
