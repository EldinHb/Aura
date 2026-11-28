package dev.aura.android.ui.settings

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aura.android.AuraApplication
import dev.aura.android.R
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val container = (context.applicationContext as AuraApplication).container
    val background by container.backgroundEnabled.collectAsStateWithLifecycle()
    val granted by container.notificationsGranted.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        container.refreshNotificationPermission()
        // Asked from the system settings instead when Android no longer shows the dialog.
        if (!it) context.startActivity(container.notificationSettingsIntent())
    }
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = { Text(stringResource(R.string.settings)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            ListItem(
                modifier = Modifier.toggleable(value = background, role = Role.Switch) { on ->
                    scope.launch { container.setBackground(on) }
                },
                leadingContent = { Icon(Icons.Outlined.CloudSync, contentDescription = null) },
                headlineContent = { Text(stringResource(R.string.setting_background)) },
                supportingContent = { Text(stringResource(R.string.setting_background_desc)) },
                trailingContent = { Switch(checked = background, onCheckedChange = null) },
            )
            if (!granted) {
                ListItem(
                    leadingContent = { Icon(Icons.Outlined.NotificationsOff, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                    headlineContent = { Text(stringResource(R.string.setting_notifications_off)) },
                    trailingContent = {
                        TextButton(onClick = {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                            } else {
                                context.startActivity(container.notificationSettingsIntent())
                            }
                        }) { Text(stringResource(R.string.setting_allow_notifications)) }
                    },
                )
            }
            ListItem(
                modifier = Modifier.clickable(role = Role.Button) { context.startActivity(container.notificationSettingsIntent()) },
                leadingContent = { Icon(Icons.Outlined.NotificationsActive, contentDescription = null) },
                headlineContent = { Text(stringResource(R.string.setting_notification_channels)) },
            )
        }
    }
}
