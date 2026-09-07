import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// The release APK is signed with a key that lives outside this repository — four
// repository secrets in CI, `~/.config/sapling/android-signing/` on the machine
// that minted them (docs/desktop.md). `keystore.properties` next to this
// project's root is how it arrives: gitignored, in the shape Tauri's own signing
// docs describe, written by the workflow and by nothing else.
//
// **Its absence may not fail the build.** A fork, or a pull request from one,
// has no secrets, and a release build is now the only build there is. So the
// fallback is Gradle's throwaway debug key: the APK still comes out, it still
// installs, and it simply cannot update one signed with the real key. Debug-
// signed rather than unsigned because an unsigned release APK is named
// `app-universal-release-unsigned.apk` and the workflow's artifact path — one
// exact file, `if-no-files-found: error` — would miss it.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
val hasReleaseKeystore = keystoreProperties.getProperty("storeFile") != null
if (!hasReleaseKeystore) {
    logger.lifecycle(
        "sapling: no gen/android/keystore.properties, so a release APK is signed with " +
            "Gradle's debug key. It installs, but never over one signed with the real " +
            "key — see docs/desktop.md."
    )
}

android {
    compileSdk = 36
    namespace = "app.sapling.desktop"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.sapling.desktop"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                // A relative `storeFile` resolves against gen/android, an
                // absolute one is left as it is: CI writes the .jks beside the
                // properties file, a laptop points at ~/.config.
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName(if (hasReleaseKeystore) "release" else "debug")
            // The WebView's console reaches logcat only through wry's `Logger`, and
            // that class drops every level — errors included — unless
            // `BuildConfig.DEBUG` is true, which is this flag. A release APK is the
            // only build there is now, and one that logs nothing cannot be
            // diagnosed on a phone (an afternoon of empty logs, 2026-09-07). Like
            // tauri's `devtools` feature it is on for the spike and comes off when
            // the app is distributed; it does not change the signing.
            isDebuggable = true
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")