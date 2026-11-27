package dev.aura.android.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily

/** Material You: the wallpaper's colors on Android 12 and later, Aura's scheme before; light or dark as the system is. */
@Composable
fun AuraTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkScheme
        else -> LightScheme
    }
    MaterialTheme(colorScheme = colorScheme, typography = Typography(), content = content)
}

/** Monospace text in the theme's body sizes: code, commands, fingerprints. */
val Typography.code
    get() = bodyMedium.copy(fontFamily = FontFamily.Monospace)

/** Small monospace text, for command output and code blocks. */
val Typography.codeSmall
    get() = bodySmall.copy(fontFamily = FontFamily.Monospace)
