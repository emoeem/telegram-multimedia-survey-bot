/**
 * 队列消息发送器的最小结构。绑定了 Queues 的部署直接用 `Queue` 本身
 * （`Queue` 天然满足此结构）；无队列部署（Workers Free）用
 * `createExportJobSender`（export-job-dispatch.service）返回的 SELF/内联
 * 降级实现。业务侧一律只依赖这个接口，不感知后端差异。
 */
export interface ExportJobSender {
  /** 返回值不约定（Queue.send 返回 QueueSendResponse，降级实现返回 void）。 */
  send(body: unknown): Promise<unknown>;
}
