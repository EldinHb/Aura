package dev.aura.android.ui

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import dev.aura.android.AuraApplication
import dev.aura.android.R
import dev.aura.android.ui.inbox.InboxScreen
import dev.aura.android.ui.inbox.waitingSessions
import dev.aura.android.ui.newsession.NewSessionScreen
import dev.aura.android.ui.pairing.AddServerScreen
import dev.aura.android.ui.servers.ServersScreen
import dev.aura.android.ui.session.SessionScreen
import dev.aura.android.ui.sessions.SessionsScreen
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable

@Serializable data object ServersRoute
@Serializable data object InboxRoute
@Serializable data class AddServerRoute(val link: String? = null)
@Serializable data class SessionsRoute(val serverId: String)
@Serializable data class SessionRoute(val serverId: String, val sessionId: String)
@Serializable data class NewSessionRoute(val serverId: String)

private fun NavDestination?.isTopLevel() = this != null && (hasRoute(ServersRoute::class) || hasRoute(InboxRoute::class))

/**
 * The app: servers and the inbox as top-level destinations in the navigation
 * bar (a rail on wide screens), and the screens under them. [pairingLinks]
 * brings `aura://pair` links the app was opened with.
 */
@Composable
fun AuraApp(pairingLinks: Flow<String>) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val destination = entry?.destination
    val container = (LocalContext.current.applicationContext as AuraApplication).container
    val waitingFlow = remember(container) { container.waitingSessions() }
    val waiting by waitingFlow.collectAsStateWithLifecycle(emptyList())

    LaunchedEffect(pairingLinks) {
        pairingLinks.collect { nav.navigate(AddServerRoute(it)) { launchSingleTop = true } }
    }

    val layout = if (destination.isTopLevel()) {
        NavigationSuiteScaffoldDefaults.calculateFromAdaptiveInfo(currentWindowAdaptiveInfo())
    } else {
        NavigationSuiteType.None
    }

    NavigationSuiteScaffold(
        layoutType = layout,
        navigationSuiteItems = {
            item(
                selected = destination?.hasRoute(ServersRoute::class) == true,
                onClick = { nav.switchTo(ServersRoute) },
                icon = {
                    Icon(if (destination?.hasRoute(ServersRoute::class) == true) Icons.Filled.Dns else Icons.Outlined.Dns, contentDescription = null)
                },
                label = { Text(stringResource(R.string.servers_title)) },
            )
            item(
                selected = destination?.hasRoute(InboxRoute::class) == true,
                onClick = { nav.switchTo(InboxRoute) },
                icon = {
                    BadgedBox(badge = { if (waiting.isNotEmpty()) Badge { Text("${waiting.size}") } }) {
                        Icon(if (destination?.hasRoute(InboxRoute::class) == true) Icons.Filled.Inbox else Icons.Outlined.Inbox, contentDescription = null)
                    }
                },
                label = { Text(stringResource(R.string.inbox_label)) },
            )
        },
    ) {
        NavHost(
            navController = nav,
            startDestination = ServersRoute,
            enterTransition = { enter() },
            exitTransition = { exit() },
            popEnterTransition = { popEnter() },
            popExitTransition = { popExit() },
        ) {
            composable<ServersRoute> {
                ServersScreen(
                    onOpen = { nav.navigate(SessionsRoute(it)) },
                    onAdd = { nav.navigate(AddServerRoute()) },
                )
            }
            composable<InboxRoute> {
                InboxScreen(onOpen = { server, session -> nav.navigate(SessionRoute(server, session)) })
            }
            composable<AddServerRoute> { back ->
                AddServerScreen(
                    link = back.toRoute<AddServerRoute>().link,
                    onBack = { nav.popBackStack() },
                    onPaired = { serverId ->
                        nav.navigate(SessionsRoute(serverId)) {
                            popUpTo<AddServerRoute> { inclusive = true }
                        }
                    },
                )
            }
            composable<SessionsRoute> { back ->
                val route = back.toRoute<SessionsRoute>()
                SessionsScreen(
                    serverId = route.serverId,
                    onBack = { nav.popBackStack() },
                    onOpen = { nav.navigate(SessionRoute(route.serverId, it)) },
                    onNew = { nav.navigate(NewSessionRoute(route.serverId)) },
                    onPairAgain = { nav.navigate(AddServerRoute()) },
                )
            }
            composable<SessionRoute> { back ->
                val route = back.toRoute<SessionRoute>()
                SessionScreen(route.serverId, route.sessionId, onBack = { nav.popBackStack() })
            }
            composable<NewSessionRoute> { back ->
                val route = back.toRoute<NewSessionRoute>()
                NewSessionScreen(
                    serverId = route.serverId,
                    onBack = { nav.popBackStack() },
                    onCreated = { id ->
                        nav.navigate(SessionRoute(route.serverId, id)) {
                            popUpTo<NewSessionRoute> { inclusive = true }
                        }
                    },
                )
            }
        }
    }
}

/** Goes to a top-level destination, keeping one copy of each and their state. */
private fun NavHostController.switchTo(route: Any) = navigate(route) {
    popUpTo(graph.findStartDestination().id) { saveState = true }
    launchSingleTop = true
    restoreState = true
}

// Material motion: fade through between top-level destinations, shared axis X
// into and out of the screens under them.

private const val MOTION_MS = 300
private const val FADE_OUT_MS = 90
private const val FADE_IN_DELAY_MS = 90
private const val SCALE_FROM = 0.92f

private fun AnimatedContentTransitionScope<NavBackStackEntry>.betweenTopLevel() =
    initialState.destination.isTopLevel() && targetState.destination.isTopLevel()

private fun fadeThroughIn() =
    fadeIn(tween(MOTION_MS - FADE_IN_DELAY_MS, delayMillis = FADE_IN_DELAY_MS)) +
        scaleIn(tween(MOTION_MS - FADE_IN_DELAY_MS, delayMillis = FADE_IN_DELAY_MS), initialScale = SCALE_FROM)

private fun AnimatedContentTransitionScope<NavBackStackEntry>.enter(): EnterTransition =
    if (betweenTopLevel()) {
        fadeThroughIn()
    } else {
        slideInHorizontally(tween(MOTION_MS)) { it / 10 } + fadeIn(tween(MOTION_MS - FADE_IN_DELAY_MS, delayMillis = FADE_IN_DELAY_MS))
    }

private fun AnimatedContentTransitionScope<NavBackStackEntry>.exit(): ExitTransition =
    if (betweenTopLevel()) {
        fadeOut(tween(FADE_OUT_MS))
    } else {
        slideOutHorizontally(tween(MOTION_MS)) { -it / 10 } + fadeOut(tween(FADE_OUT_MS))
    }

private fun AnimatedContentTransitionScope<NavBackStackEntry>.popEnter(): EnterTransition =
    if (betweenTopLevel()) {
        fadeThroughIn()
    } else {
        slideInHorizontally(tween(MOTION_MS)) { -it / 10 } + fadeIn(tween(MOTION_MS - FADE_IN_DELAY_MS, delayMillis = FADE_IN_DELAY_MS))
    }

private fun AnimatedContentTransitionScope<NavBackStackEntry>.popExit(): ExitTransition =
    if (betweenTopLevel()) {
        fadeOut(tween(FADE_OUT_MS))
    } else {
        slideOutHorizontally(tween(MOTION_MS)) { it / 10 } + fadeOut(tween(FADE_OUT_MS))
    }
