package dev.aura.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.aura.android.AppContainer
import dev.aura.android.AuraApplication

/** A view model made from the app's [AppContainer]; [key] tells apart ones of the same class. */
@Composable
inline fun <reified VM : ViewModel> appViewModel(key: String? = null, crossinline create: (AppContainer) -> VM): VM {
    val container = (LocalContext.current.applicationContext as AuraApplication).container
    return viewModel(key = key) { create(container) }
}
