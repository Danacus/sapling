import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """pnpm""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                var built = false
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        built = true
                        break
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                if (!built) {
                    throw lastException
                }
            } else {
                throw e;
            }
        }
        packageSherpaLibraries()
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("tauri", "android", "android-studio-script");

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }

    private fun packageSherpaLibraries() {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val abi = when (target) {
            "aarch64" -> "arm64-v8a"
            "armv7" -> "armeabi-v7a"
            "i686" -> "x86"
            "x86_64" -> "x86_64"
            else -> throw GradleException("no Android ABI is known for Rust target $target")
        }
        val rustProjectDir = File(project.projectDir, rootDirRel).canonicalFile
        val workspaceDir = rustProjectDir.parentFile.parentFile
        val configuredTargetDir = System.getenv("CARGO_TARGET_DIR")
        val cargoTargetDir = if (configuredTargetDir == null) {
            File(workspaceDir, "target")
        } else {
            File(configuredTargetDir).let {
                if (it.isAbsolute) it else File(rustProjectDir, configuredTargetDir)
            }
        }
        val overriddenLibDir = System.getenv("SHERPA_ONNX_LIB_DIR")
        val sourceDir = if (overriddenLibDir == null) {
            File(cargoTargetDir, "sherpa-onnx-prebuilt/jniLibs/$abi")
        } else {
            File(overriddenLibDir).let {
                if (it.isAbsolute) it else File(rustProjectDir, overriddenLibDir)
            }
        }
        val destinationDir = File(project.projectDir, "src/main/jniLibs/$abi")
        destinationDir.mkdirs()

        listOf("libsherpa-onnx-c-api.so", "libonnxruntime.so").forEach { name ->
            val source = File(sourceDir, name)
            if (!source.isFile) {
                throw GradleException(
                    "speech needs $name in the APK and it is not at ${source.absolutePath}"
                )
            }
            val destination = File(destinationDir, name)
            source.copyTo(destination, overwrite = true)
            logger.lifecycle(
                "sapling: packaged $name (${source.length()} bytes) into ${destination.absolutePath}"
            )
        }
    }
}
