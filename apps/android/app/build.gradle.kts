import java.util.Base64

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * The release keystore, from the environment: AURA_ANDROID_KEYSTORE holds the
 * keystore base64-encoded, with AURA_ANDROID_KEYSTORE_PASSWORD,
 * AURA_ANDROID_KEY_ALIAS and AURA_ANDROID_KEY_PASSWORD. Without them a
 * release build is signed with the debug key, so the APK still installs.
 */
val releaseKeystore: File? = System.getenv("AURA_ANDROID_KEYSTORE")
    ?.takeIf { it.isNotBlank() }
    ?.let { encoded ->
        val file = layout.buildDirectory.file("release.keystore").get().asFile
        file.parentFile.mkdirs()
        file.writeBytes(Base64.getMimeDecoder().decode(encoded))
        file
    }

android {
    namespace = "dev.aura.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.aura.android"
        minSdk = 26
        targetSdk = 37
        versionCode = 600
        versionName = "0.6.0"
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = System.getenv("AURA_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("AURA_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("AURA_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        warningsAsErrors = false
        abortOnError = true
        checkDependencies = false
        // Library versions are chosen deliberately in the version catalog.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion")
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.material3.navigation.suite)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.zxing.embedded)
    implementation(libs.zxing.core)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.tls)
    testImplementation(libs.okhttp.mockwebserver)
}
