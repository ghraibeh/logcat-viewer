plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mobilelabkit.mirror"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mobilelabkit.mirror"
        minSdk = 26                 // NsdManager TXT attrs, MediaProjection, adaptive icons
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
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
    // Intentionally none — Android→Android mirror is pure platform: MediaProjection +
    // MediaCodec + NsdManager + plain TCP sockets. Same dependency-light ethos as the
    // sibling android-chromecast / android-airplay receivers.
}
