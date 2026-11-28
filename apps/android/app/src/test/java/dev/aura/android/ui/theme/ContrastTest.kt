package dev.aura.android.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The color pairs the cards that ask the user something use (decisions,
 * approvals, questions, Aura's messages), in the fallback schemes: body text
 * at WCAG AA (4.5:1), icons and outlines at 3:1. Dynamic schemes are made by
 * the same tone rules; they were checked on an emulator with several seeds.
 */
class ContrastTest {
    private fun ratio(a: Color, b: Color): Double {
        val (hi, lo) = listOf(a.luminance() + 0.05, b.luminance() + 0.05).sortedDescending()
        return (hi / lo).toDouble()
    }

    private fun check(scheme: ColorScheme, name: String) {
        val text = listOf(
            "onSurface on surfaceContainerHigh (open card)" to (scheme.onSurface to scheme.surfaceContainerHigh),
            "onSurfaceVariant on surfaceContainerHigh (descriptions, field label)" to (scheme.onSurfaceVariant to scheme.surfaceContainerHigh),
            "onSurface on surfaceContainer (answered card)" to (scheme.onSurface to scheme.surfaceContainer),
            "onSurfaceVariant on surfaceContainer (answered label)" to (scheme.onSurfaceVariant to scheme.surfaceContainer),
            "primary on surfaceContainerHigh (text buttons)" to (scheme.primary to scheme.surfaceContainerHigh),
            "onPrimary on primary (Answer button)" to (scheme.onPrimary to scheme.primary),
            "onSecondaryContainer on secondaryContainer (Recommended, Aura's messages)" to (scheme.onSecondaryContainer to scheme.secondaryContainer),
            "onErrorContainer on errorContainer (Needs your yes)" to (scheme.onErrorContainer to scheme.errorContainer),
            "onSurface on surfaceContainerHighest (inline code)" to (scheme.onSurface to scheme.surfaceContainerHighest),
        )
        for ((what, pair) in text) {
            val r = ratio(pair.first, pair.second)
            assertTrue("$name: $what is %.2f:1".format(r), r >= 4.5)
        }
        val shapes = listOf(
            "tertiary outline and icon on surfaceContainerHigh" to (scheme.tertiary to scheme.surfaceContainerHigh),
            "unselected radio (onSurfaceVariant) on surfaceContainerHigh" to (scheme.onSurfaceVariant to scheme.surfaceContainerHigh),
        )
        for ((what, pair) in shapes) {
            val r = ratio(pair.first, pair.second)
            assertTrue("$name: $what is %.2f:1".format(r), r >= 3.0)
        }
    }

    @Test
    fun `the light fallback scheme reads`() = check(LightScheme, "light")

    @Test
    fun `the dark fallback scheme reads`() = check(DarkScheme, "dark")
}
