plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// "AA Wireless Helper" — a tiny app for the SOURCE PHONE (the one running Android Auto).
// It has no protobuf/AA-protocol code at all: its only job is to fire Google's hidden
// "wireless startup" trigger so stock Android Auto TCP-connects to our head unit's :5288
// over the shared Wi-Fi. Separate applicationId so it installs alongside anything else.
android {
    namespace = "com.mobilelabkit.aahelper"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mobilelabkit.aahelper"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "0.2"
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
    // ComponentActivity for registerForActivityResult (the QR ScanContract flow below).
    implementation("androidx.activity:activity:1.8.2")
    // QR scanner for the SoftAP "Host Wi-Fi" join code the head unit shows (camera + decode).
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
