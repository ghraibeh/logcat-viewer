plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mobilelabkit.airplay"
    compileSdk = 34
    ndkVersion = "26.3.11579264"

    defaultConfig {
        applicationId = "com.mobilelabkit.airplay"
        minSdk = 26                 // AAudio (miniaudio) + adaptive icons
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // One ABI covers the Galaxy A55 and arm64 emulators; add x86_64 for Intel
        // emulators (also build that ABI's deps: ABIS="arm64-v8a x86_64" build-android-deps.sh).
        ndk { abiFilters += listOf("arm64-v8a") }

        externalNativeBuild {
            cmake {
                // c++_static: fdk-aac (C++) needs libc++, but we have a single .so, so link
                // it statically — no separate libc++_shared.so to also 16 KB-align/ship.
                arguments += listOf("-DANDROID_STL=c++_static")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
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
    // Intentionally none — plain android.app.Activity + platform MediaCodec/AudioTrack,
    // matching the receiver's dependency-light ethos. All heavy lifting is in the .so.
}
