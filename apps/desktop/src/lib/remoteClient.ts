/**
 * The client for a remote computer, through the desktop shell's bridge
 * (`ws://127.0.0.1:<bridge port>/ws?token=<secret>`, see
 * crates/aura-remote-client). It speaks to the remote's daemon like the local
 * client does, but refuses what the remote would refuse before sending it,
 * with words that say so, and shapes `session.create` the way a remote takes it.
 */
import type { CreateSessionOpts, ProviderKind, Session } from "../gen";
import { RpcClient, RpcError } from "./rpc";
import { refusalMessage, remoteAllows, remoteCreateParams } from "./remoteCapabilities";

/** -32003, as the remote's daemon answers a method it does not allow. */
export const ERR_FORBIDDEN = -32003;

export class RemoteRpcClient extends RpcClient {
  /** The remote computer's id (its server id). */
  readonly computerId: string;

  constructor(computerId: string, port: number, token: string) {
    super(port, token);
    this.computerId = computerId;
  }

  override call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!remoteAllows(method)) return Promise.reject(new RpcError(refusalMessage(method), ERR_FORBIDDEN));
    return super.call<T>(method, params);
  }

  override createSession(opts: Partial<CreateSessionOpts> & { provider: ProviderKind; cwd: string }) {
    let params: Record<string, unknown>;
    try {
      params = remoteCreateParams(opts);
    } catch (e) {
      return Promise.reject(new RpcError(e instanceof Error ? e.message : String(e), ERR_FORBIDDEN));
    }
    return super.call<Session>("session.create", params);
  }

  /** Remote computers get no terminals. */
  override ptyInput() {}
}

export function isRemoteClient(c: unknown): c is RemoteRpcClient {
  return c instanceof RemoteRpcClient;
}
