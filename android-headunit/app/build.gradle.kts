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
        versionName = "0.12"
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
    // Modern Android Auto protocol messages: the pre-generated protobuf Java from
    // headunit-revived (GPLv3) is vendored under aap/protocol/proto/, so we use full
    // protobuf-java at runtime (not the gradle protoc plugin — the protos have duplicate
    // top-level enum names across files that full protoc rejects but the committed code
    // handles). This is the CURRENT AA protocol; aasdk's 2018 protos are too old.
    implementation("com.google.protobuf:protobuf-java:3.25.3")
}
