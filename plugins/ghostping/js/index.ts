import { ToastActionCreators } from '@valenced/discord/actions'
import { onFluxEventDispatched } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'

// ApplicationCommandOptionType
const STRING = 3
const INTEGER = 4
const BOOLEAN = 5
const USER = 6

// The suppress-notifications flag the app sets for "@silent".
const SUPPRESS_NOTIFICATIONS = 4096

interface CommandArgument {
	name: string
	value: unknown
}

interface CommandContext {
	channel: { id: string }
}

interface RestResponse {
	body?: { id?: string }
}

// biome-ignore lint/suspicious/noExplicitAny: Discord's modules are untyped.
type AnyModule = any

// The command library plugin (dev.cocobo1.command-lib) adds this to the plugin API.
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

const toast = (text: string) => ToastActionCreators.open('GHOSTPING', { text })

const makeNonce = () =>
	String(Date.now()) + String(Math.floor(Math.random() * 1e6))

export default plugin({
	start(api) {
		const { cleanup, logger } = api
		const { registerCommand } = api.unscoped.commandlib.commands

		const MessageActions: AnyModule = lookupModule(
			withProps('sendMessage', 'receiveMessage'),
		)[0]
		const Deleter: AnyModule =
			lookupModule(withProps('deleteMessage', 'startEditMessage'))[0] ??
			MessageActions

		// Fast path: talk to Discord's REST API directly. This skips the client's send queue
		// and optimistic-message handling, so the delete fires the moment the server replies.
		const RestAPI: AnyModule = lookupModule(
			withProps('getAPIBaseURL', 'get'),
		)[0]
		const restDelete = RestAPI && (RestAPI.del ?? RestAPI.delete)

		const pending = new Set<() => void>()
		cleanup(() => {
			for (const c of [...pending]) c()
		})

		async function sendAndDeleteFast(
			channelId: string,
			content: string,
			delayMs: number,
			silent: boolean,
		) {
			const res: RestResponse = await RestAPI.post({
				url: `/channels/${channelId}/messages`,
				body: {
					content,
					tts: false,
					nonce: makeNonce(),
					...(silent ? { flags: SUPPRESS_NOTIFICATIONS } : {}),
				},
			})
			const id = res?.body?.id
			if (!id) throw new Error('no message id in response')
			if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
			await restDelete.call(RestAPI, {
				url: `/channels/${channelId}/messages/${id}`,
			})
		}

		function sendAndDeleteSlow(
			channelId: string,
			content: string,
			delayMs: number,
			silent: boolean,
		) {
			const nonce = makeNonce()
			let done = false
			let timeout: ReturnType<typeof setTimeout> | undefined
			let unsubscribe: (() => void) | undefined

			const finish = () => {
				done = true
				unsubscribe?.()
				clearTimeout(timeout)
				pending.delete(finish)
			}

			const remove = (id: string) => {
				if (done) return
				finish()
				const doDelete = () => {
					try {
						Deleter.deleteMessage(channelId, id)
					} catch (e) {
						logger.error('Delete failed', e)
					}
				}
				if (delayMs > 0) setTimeout(doDelete, delayMs)
				else doDelete()
			}

			// The confirmed (non-optimistic) message arrives via MESSAGE_CREATE with our nonce.
			unsubscribe = onFluxEventDispatched('MESSAGE_CREATE', payload => {
				const event = payload as {
					optimistic?: boolean
					message?: { id: string; nonce?: string; state?: string }
				}
				const m = event.message
				if (
					m &&
					!event.optimistic &&
					m.nonce === nonce &&
					m.state !== 'SENDING'
				)
					remove(m.id)
				// Always pass the event through untouched.
				return payload
			})
			pending.add(finish)
			timeout = setTimeout(finish, 15000)

			const res = MessageActions.sendMessage(
				channelId,
				{
					// Discord turns a leading "@silent " into the suppress-notifications flag server-side
					content: silent ? `@silent ${content}` : content,
					invalidEmojis: [],
					tts: false,
					validNonShortcutEmojis: [],
				},
				undefined,
				{ nonce },
			)

			// Fallback: some versions resolve with the created message.
			Promise.resolve(res)
				.then((r: RestResponse) => {
					const id = r?.body?.id
					if (id) remove(id)
				})
				.catch(() => {})
		}

		function sendAndDelete(
			channelId: string,
			content: string,
			delayMs: number,
			silent: boolean,
		) {
			if (RestAPI?.post && restDelete) {
				sendAndDeleteFast(channelId, content, delayMs, silent).catch(e =>
					logger.error('Fast path failed', e),
				)
				return
			}
			sendAndDeleteSlow(channelId, content, delayMs, silent)
		}

		cleanup(
			registerCommand({
				name: 'ghostping',
				displayName: 'ghostping',
				description: 'Send a message and delete it right after (ghost ping)',
				displayDescription:
					'Send a message and delete it right after (ghost ping)',
				applicationId: '-1',
				inputType: 1,
				type: 1,
				shouldHide: () => false,
				options: [
					{
						name: 'user',
						displayName: 'user',
						description: 'User to ping',
						displayDescription: 'harrass someone',
						required: false,
						type: USER,
					},
					{
						name: 'message',
						displayName: 'message',
						description: 'Extra text (use <@userId> to ping more people)',
						displayDescription:
							'say somthing they wont read or ping more people',
						required: false,
						type: STRING,
					},
					{
						name: 'delay',
						displayName: 'delay',
						description: 'Milliseconds to wait before deleting (default 0)',
						displayDescription:
							'these are miliseleconds before deleting. its at 0.',
						required: false,
						type: INTEGER,
					},
					{
						name: 'silent',
						displayName: 'silent',
						description:
							'Send as a silent message (no push/desktop notification)',
						displayDescription:
							'Send as a silent message (no push/desktop notification)',
						required: false,
						type: BOOLEAN,
					},
				],
				execute(args: CommandArgument[], ctx: CommandContext) {
					const get = (n: string) => args.find(a => a.name === n)?.value
					const user = get('user')
					const text = get('message')
					const delay = Math.max(0, Number(get('delay')) || 0)

					const content = [user ? `<@${user}>` : '', text ?? '']
						.filter(Boolean)
						.join(' ')
					// A toast instead of returning a message: the command library sends
					// returned objects to the channel as a real message.
					if (!content) return void toast('GhostPing: give me a user or a message.')

					sendAndDelete(ctx.channel.id, content, delay, !!get('silent'))
				},
			}),
		)
	},
})
