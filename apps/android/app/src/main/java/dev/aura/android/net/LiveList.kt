package dev.aura.android.net

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * A list the server keeps current with events, reloaded now and then. While a
 * reload is on its way, the events that come meanwhile are kept and applied
 * again on top of the reloaded list, unless the list already has something
 * newer ([newer]), so neither a reload nor an early event is lost. Every
 * change is serialized.
 */
class LiveList<T : Any>(
    private val key: (T) -> String,
    /** Whether [incoming] is at least as recent as [existing]. */
    private val newer: (incoming: T, existing: T) -> Boolean,
) {
    private val _items = MutableStateFlow<List<T>?>(null)

    /** The list; null until first loaded. */
    val items: StateFlow<List<T>?> = _items

    private sealed interface Change<T> {
        data class Upsert<T>(val item: T) : Change<T>
        data class Remove<T>(val key: String) : Change<T>
    }

    private var reloads = 0
    private val changes = mutableListOf<Change<T>>()

    /** A reload was asked for: events from now on are kept for [endReload]. */
    @Synchronized
    fun beginReload() {
        if (reloads++ == 0) changes.clear()
    }

    /** The reload answered [snapshot], or failed (null) and the list stays as it is. */
    @Synchronized
    fun endReload(snapshot: List<T>?) {
        if (snapshot != null) {
            _items.value = changes.fold(snapshot) { list, change -> list.apply(change, onlyIfNewer = true) }
        }
        if (--reloads == 0) changes.clear()
    }

    @Synchronized
    fun upsert(item: T) = change(Change.Upsert(item))

    @Synchronized
    fun remove(key: String) = change(Change.Remove(key))

    private fun change(change: Change<T>) {
        if (reloads > 0) changes += change
        _items.value?.let { _items.value = it.apply(change, onlyIfNewer = false) }
    }

    private fun List<T>.apply(change: Change<T>, onlyIfNewer: Boolean): List<T> = when (change) {
        is Change.Remove -> filterNot { key(it) == change.key }
        is Change.Upsert -> {
            val i = indexOfFirst { key(it) == key(change.item) }
            when {
                i < 0 -> this + change.item
                onlyIfNewer && !newer(change.item, this[i]) -> this
                else -> toMutableList().also { it[i] = change.item }
            }
        }
    }
}
