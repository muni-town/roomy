buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.5.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
        // Declared on the root buildscript classpath rather than in a
        // `plugins { id("com.google.gms.google-services") version "..." }`
        // block: `com.google.gms:google-services` is published to Google's
        // Maven repo only, and there is no plugin marker for it on the Gradle
        // Plugin Portal. A plugins-block request resolves its marker through
        // `pluginManagement` repositories (the portal by default), which this
        // generated project does not configure, so it fails with "Plugin
        // [id: 'com.google.gms.google-services', version: '4.4.2'] was not
        // found". The app module applies the plugin by id without a version,
        // which resolves from this classpath.
        classpath("com.google.gms:google-services:4.4.2")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
