package dev.aura.android.ui.usage

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.aura.android.ui.theme.Spacing

private val ChartHeight = 120.dp
private val BarGap = 2.dp
private val LineWidth = 2.dp
private val DotRadius = 3.dp

/** Bars of [values], left to right, scaled to the largest; [first] and [last] label the ends. */
@Composable
fun BarChart(values: List<Double>, first: String, last: String, description: String, modifier: Modifier = Modifier) {
    val bar = MaterialTheme.colorScheme.primary
    val track = MaterialTheme.colorScheme.surfaceContainerHighest
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Canvas(Modifier.fillMaxWidth().height(ChartHeight).semantics { contentDescription = description }) {
            if (values.isEmpty()) return@Canvas
            val max = values.max().takeIf { it > 0 } ?: 1.0
            val gap = BarGap.toPx()
            val w = ((size.width - gap * (values.size - 1)) / values.size).coerceAtLeast(1f)
            val radius = CornerRadius(minOf(w / 2, 4.dp.toPx()))
            values.forEachIndexed { i, v ->
                val x = i * (w + gap)
                drawRoundRect(track, Offset(x, 0f), Size(w, size.height), radius, alpha = 0.4f)
                val h = (v / max * size.height).toFloat()
                if (h > 0) drawRoundRect(bar, Offset(x, size.height - h), Size(w, h), radius)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(first, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(last, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** A line through [values] (null: not known, skipped), scaled from 0 to [ceiling] or the largest. */
@Composable
fun LineChart(values: List<Double?>, description: String, modifier: Modifier = Modifier, ceiling: Double? = null) {
    val line = MaterialTheme.colorScheme.tertiary
    val grid = MaterialTheme.colorScheme.outlineVariant
    Canvas(modifier.fillMaxWidth().height(ChartHeight).semantics { contentDescription = description }) {
        drawLine(grid, Offset(0f, size.height), Offset(size.width, size.height))
        val known = values.filterNotNull()
        if (known.isEmpty()) return@Canvas
        val max = (ceiling ?: known.max()).takeIf { it > 0 } ?: 1.0
        val step = if (values.size > 1) size.width / (values.size - 1) else 0f
        val points = values.mapIndexedNotNull { i, v -> v?.let { Offset(i * step, size.height - (it / max * size.height).toFloat().coerceIn(0f, size.height)) } }
        val path = Path()
        points.forEachIndexed { i, p -> if (i == 0) path.moveTo(p.x, p.y) else path.lineTo(p.x, p.y) }
        drawPath(path, line, style = Stroke(LineWidth.toPx()))
        if (points.size == 1) drawCircle(line, DotRadius.toPx(), points[0])
    }
}
