package app.sapling.desktop

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Everything above `onCreate`'s first line is the Tauri template. The window
 * insets are ours, and they are why `gen/android` is committed.
 *
 * The template opts this window into edge-to-edge explicitly, and the project
 * it generates targets SDK 36, so the window is laid out *behind* the status
 * bar and the gesture bar and the app painted under both. Neither of the two
 * cheaper answers works here: `android:windowOptOutEdgeToEdgeEnforcement` only
 * switches off the framework's own enforcement — it cannot undo the
 * `enableEdgeToEdge()` below — and it is deprecated and ignored outright for an
 * app targeting SDK 36 on an Android 16 device. So the insets are applied where
 * they are a fact rather than a guess: as padding on the activity's content
 * view, which is the `FrameLayout` wry drops the WebView into
 * (`activity.setContentView(webView)`), so the WebView is *sized* to the safe
 * area instead of drawing into it. Nothing in the web app has to know, and in
 * particular nothing rests on `env(safe-area-inset-*)`, whose support in
 * Android's WebView under edge-to-edge is not something this repo can verify.
 *
 * `enableEdgeToEdge()` stays, which keeps one code path on every API level:
 * the window is edge-to-edge from minSdk 24 up, and this listener is the only
 * thing that ever insets the content.
 *
 * The IME is deliberately not in the mask. A keyboard that covers a focused
 * input is the behaviour the app already has on this host, and changing when
 * the WebView resizes is exactly the kind of change that needs a device.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    // The listener is attached before the WebView exists and after the first
    // dispatch may already have happened; asking for one covers both.
    ViewCompat.requestApplyInsets(content)
  }
}
