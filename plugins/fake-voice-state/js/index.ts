import { ToastActionCreators } from '@valenced/discord/actions'
import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { before } from '@valenced/patcher'

const STRING = 3 // ApplicationCommandOptionType.STRING
const ON_WORDS = ['on', 'true', 'yes', '1', 'enable']
const OFF_WORDS = ['off', 'false', 'no', '0', 'disable']

interface Settings {
	fakeMute: boolean
	fakeDeafen: boolean
}

interface VoiceState {
	guildId?: string | null
	channelId?: string | null
	selfMute?: boolean
	selfDeaf?: boolean
	selfVideo?: boolean
	[key: string]: unknown
}

interface GatewaySocket {
	voiceStateUpdate?: (state: VoiceState) => void
}

// The command library plugin (dev.cocobo1.command-lib) adds this to the plugin API.
interface CommandArgument {
	name: string
	value: string
}

interface CommandLib {
	commands: {
		registerCommand: (command: unknown) => () => void
	}
}

declare module '@valenced/plugins/types' {
	interface UnscopedPluginApi {
		commandlib: CommandLib
	}
}

const toast = (text: string) => ToastActionCreators.open('FAKE_VOICE_STATE', { text })

export default plugin<{ jsonStorage: Settings }>({
	// Eagerly load the settings file.
	jsonStorage: {
		load: true,
		default: { fakeMute: false, fakeDeafen: false },
	},
	start(api) {
		const { cleanup, jsonStorage, logger } = api
		const { registerCommand } = api.unscoped.commandlib.commands

		// biome-ignore lint/suspicious/noExplicitAny: Discord's stores are untyped.
		const stores = Stores as Record<string, any>
		let GatewayConnectionStore = stores.GatewayConnectionStore
		const MediaEngineStore = stores.MediaEngineStore
		const SelectedChannelStore = stores.SelectedChannelStore
		const ChannelStore = stores.ChannelStore

		if (!GatewayConnectionStore)
			GatewayConnectionStore = lookupModule(withProps('getSocket'))[0] ?? null

		const getSocket = (): GatewaySocket | null =>
			GatewayConnectionStore?.getSocket?.() ?? null

		// Sends the current voice state again so the change shows up right away,
		// instead of waiting until the next time you really mute/unmute.
		function resend() {
			const socket = getSocket()
			const channelId = SelectedChannelStore?.getVoiceChannelId?.()
			if (!socket?.voiceStateUpdate || !channelId) return false

			const channel = ChannelStore?.getChannel?.(channelId)
			try {
				socket.voiceStateUpdate({
					guildId: channel?.guild_id ?? channel?.guildId ?? null,
					channelId,
					selfMute: !!MediaEngineStore?.isSelfMute?.(),
					selfDeaf: !!MediaEngineStore?.isSelfDeaf?.(),
					selfVideo: !!MediaEngineStore?.isVideoEnabled?.(),
				})
				return true
			} catch (e) {
				logger.error('Failed to resend voice state', e)
				return false
			}
		}

		// Registered first, so it runs last: cleanups run in reverse order.
		// With the patch gone this sends your real state, so you don't stay stuck looking muted.
		cleanup(() => {
			const settings = jsonStorage.cache
			if (settings?.fakeMute || settings?.fakeDeafen) resend()
		})

		// Overwrites what Discord tells the server about your mute/deafen state.
		// Your real state is untouched, so you keep hearing and (for mute) can keep talking locally.
		// Valenced's `before` hooks must always return the argument list to pass on.
		function onVoiceStateUpdate(args: [VoiceState]): [VoiceState] {
			const [state] = args
			if (!state || typeof state !== 'object') return args

			const settings = jsonStorage.cache
			if (!settings?.fakeMute && !settings?.fakeDeafen) return args

			const selfDeaf = !!state.selfDeaf || !!settings.fakeDeafen
			// Being deafened always shows as muted too, same as the real thing.
			const selfMute = !!state.selfMute || !!settings.fakeMute || selfDeaf
			return [{ ...state, selfMute, selfDeaf }]
		}

		const socket = getSocket()
		// Patch the prototype so it keeps working after the gateway reconnects with a new socket.
		const proto = socket ? Object.getPrototypeOf(socket) : null
		if (
			proto &&
			proto !== Object.prototype &&
			typeof proto.voiceStateUpdate === 'function'
		) {
			cleanup(before(proto, 'voiceStateUpdate', onVoiceStateUpdate))
		} else if (socket && typeof socket.voiceStateUpdate === 'function') {
			cleanup(
				before(
					socket as Required<GatewaySocket>,
					'voiceStateUpdate',
					onVoiceStateUpdate,
				),
			)
		} else {
			logger.error("Couldn't find the gateway voiceStateUpdate function")
		}

		function makeCommand(name: string, key: keyof Settings, label: string) {
			return {
				name,
				displayName: name,
				description: `Toggle ${label}. Optionally pass on or off`,
				displayDescription: `Toggle ${label}. Optionally pass on or off`,
				options: [
					{
						name: 'state',
						displayName: 'state',
						description: 'on or off (leave empty to toggle)',
						displayDescription: 'on or off (leave empty to toggle)',
						type: STRING,
						required: false,
					},
				],
				shouldHide: () => false,
				async execute(args: CommandArgument[]) {
					const raw = args?.find(a => a?.name === 'state')?.value
					const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''

					let next: boolean
					if (!value) next = !jsonStorage.cache?.[key]
					else if (ON_WORDS.includes(value)) next = true
					else if (OFF_WORDS.includes(value)) next = false
					else
						return void toast(
							`Use /${name} on, /${name} off, or just /${name} to toggle`,
						)

					// Wait for the new value to be in the cache before resending,
					// since the patched voiceStateUpdate reads it from there.
					await jsonStorage.set({ [key]: next })
					const sent = resend()
					const inCall = !!SelectedChannelStore?.getVoiceChannelId?.()

					toast(
						`${label[0].toUpperCase()}${label.slice(1)} ${next ? 'on' : 'off'}` +
							(!inCall
								? '. Applies next time you join a call'
								: sent
									? ''
									: ". Couldn't refresh now, it applies on your next mute/unmute"),
					)
				},
			}
		}

		cleanup(registerCommand(makeCommand('fakemute', 'fakeMute', 'fake mute')))
		cleanup(
			registerCommand(makeCommand('fakedeafen', 'fakeDeafen', 'fake deafen')),
		)
	},
})
