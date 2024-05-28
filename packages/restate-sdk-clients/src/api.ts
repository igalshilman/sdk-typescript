import type {
  ServiceDefinition,
  VirtualObjectDefinition,
  WorkflowDefinition,
} from "@restatedev/restate-sdk-core";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Ingress {
  /**
   * Create a client from a {@link ServiceDefinition}.
   */
  serviceClient<M, P extends string = string>(
    opts: ServiceDefinition<P, M>
  ): IngressClient<M>;

  /**
   * Create a client from a {@link WorkflowDefinition}.
   */
  workflowClient<M, P extends string = string>(
    opts: WorkflowDefinition<P, M>,
    key: string
  ): IngressWorkflowClient<M>;

  /**
   * Create a client from a {@link VirtualObjectDefinition}.
   */
  objectClient<M, P extends string = string>(
    opts: VirtualObjectDefinition<P, M>,
    key: string
  ): IngressClient<M>;

  /**
   * Resolve an awakeable from the ingress client.
   */
  resolveAwakeable<T>(id: string, payload?: T): Promise<void>;

  /**
   * Reject an awakeable from the ingress client.
   */
  rejectAwakeable(id: string, reason: string): Promise<void>;
}

export interface IngresCallOptions {
  /**
   * Key to use for idempotency key.
   *
   * See https://docs.restate.dev/operate/invocation#invoke-a-handler-idempotently for more details.
   */
  idempotencyKey?: string;

  /**
   * Headers to attach to the request.
   */
  headers?: Record<string, string>;

  send?: boolean;

  delay?: number;
}

export class Opts<T extends IngresCallOptions = any> {
  public static from<T extends IngresCallOptions = IngresCallOptions>(
    opts: T
  ): Opts<T> {
    return new Opts<T>(opts);
  }

  constructor(readonly opts: T) {}
}

export type SendOr<T, O> = O extends Opts<infer OO>
  ? OO["send"] extends true
    ? SendResponse
    : OO["delay"] extends number
    ? SendResponse
    : T
  : T;

export type IngressClient<M> = {
  [K in keyof M as M[K] extends never ? never : K]: M[K] extends (
    ...args: infer P
  ) => PromiseLike<infer O>
    ? <Options = unknown>(
        ...args: [...P, ...[opts?: Options]]
      ) => PromiseLike<SendOr<O, Options>>
    : never;
};

export interface Output<O> {
  ready: boolean;
  result: O;
}

export type WorkflowSubmission = {
  invocationId: string;
  status: "Accepted" | "PreviouslyAccepted";
};

export type IngressWorkflowClient<M> = Omit<
  {
    [K in keyof M as M[K] extends never ? never : K]: M[K] extends (
      ...args: any
    ) => PromiseLike<unknown>
      ? M[K]
      : never;
  } & {
    /**
     * Submit this workflow.
     *
     * This instructs restate to execute the 'run' handler.
     *
     * @param argument the same argument type as defined by the 'run' handler.
     */
    workflowSubmit: M extends Record<string, unknown>
      ? M["run"] extends (...args: infer I) => Promise<unknown>
        ? (...args: I) => Promise<WorkflowSubmission>
        : never
      : never;

    workflowAttach: M extends Record<string, unknown>
      ? M["run"] extends (...args: any) => Promise<infer O>
        ? () => Promise<O>
        : never
      : never;

    workflowOutput: M extends Record<string, unknown>
      ? M["run"] extends (...args: any) => Promise<infer O>
        ? () => Promise<Output<O>>
        : never
      : never;
  },
  "run"
>;

export type SendResponse = {
  invocationId: string;
  status: "Accepted" | "PreviouslyAccepted";
};

export type ConnectionOpts = {
  /**
   * Restate URL.
   */
  url: string;
  /**
   * Headers to attach on every request.
   */
  headers?: Record<string, string>;
};
