import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Loader2, RefreshCw, Search } from "lucide-react";
import {
  ApiError,
  RemoteRequestError,
  createRemoteClient,
  isRemoteNotConfigured,
  userChatLink,
  type DeploymentView,
  type RemoteAnswer,
  type RemoteClient,
  type RemoteListData,
  type RemoteResponse,
  type RemoteResponseDetail,
  type RemoteSummaryData,
  type RemoteSurvey,
  type RemoteUser,
  type SurveyStatus,
} from "../api";
import { formatDateTime, STATUS_LABELS } from "../format";
import { EmptyPanel, Modal, StatusBadge } from "./ui";

/**
 * Read-only 客户数据 viewer for one customer deployment.
 *
 * It never writes to the instance: every call is a GET against `/api/remote/*`
 * with a short-lived bearer token the control plane mints for this browser.
 */

type RemoteTab = "summary" | "surveys" | "responses" | "users";

const TABS: Array<{ id: RemoteTab; label: string }> = [
  { id: "summary", label: "概览" },
  { id: "surveys", label: "问卷" },
  { id: "responses", label: "答卷" },
  { id: "users", label: "用户" },
];

const PAGE_SIZE = 25;
/** The instance caps a page at 100 rows, so the filter list can only be partial. */
const SURVEY_OPTION_PAGE = 100;

const RESPONSE_STATUS_LABELS: Record<string, string> = {
  in_progress: "填写中",
  completed: "已完成",
  abandoned: "已放弃",
  cancelled: "已取消",
  archived: "已归档",
};

/**
 * `abandoned` is deliberately absent: the instance's read-only endpoint only
 * accepts in_progress/completed/cancelled/archived and silently ignores
 * anything else, so offering it would quietly return every status.
 */
const RESPONSE_STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "completed", label: "已完成" },
  { value: "in_progress", label: "填写中" },
  { value: "cancelled", label: "已取消" },
  { value: "archived", label: "已归档" },
];

/** Token-endpoint error codes the vendor can actually act on. */
const TOKEN_ERROR_TEXT: Record<string, string> = {
  remote_access_not_configured: "该实例尚未上报只读访问密钥，请先完成一次心跳。",
  remote_secret_invalid: "该实例上报的只读密钥无法解密，请重新部署该实例。",
  runner_secret_not_configured: "控制中心缺少 Runner 密钥，无法签发只读令牌。",
  vendor_only: "当前部署不是授权中心，不能读取客户数据。",
  deployment_not_found: "该部署已不存在，请刷新控制中心。",
};

interface RemoteErrorInfo {
  message: string;
  notConfigured: boolean;
}

interface RemoteQueryState<T> {
  data: T | null;
  loading: boolean;
  error: RemoteErrorInfo | null;
  reload: () => void;
}

function describeError(error: unknown): RemoteErrorInfo {
  if (isRemoteNotConfigured(error)) {
    return { message: error.message, notConfigured: true };
  }
  if (error instanceof RemoteRequestError) {
    return { message: error.message, notConfigured: false };
  }
  if (error instanceof ApiError) {
    const data = error.data ?? {};
    const code = typeof data.error === "string" ? data.error : "";
    return { message: TOKEN_ERROR_TEXT[code] ?? error.message, notConfigured: false };
  }
  return {
    message: error instanceof Error ? error.message : "读取失败，请稍后重试。",
    notConfigured: false,
  };
}

/**
 * Loads one read-only view through a shared client.
 *
 * `viewKey` is bumped by the viewer whenever a view is opened or refreshed; the
 * hook then mints a fresh token for that view, while paging and filtering inside
 * the same view reuse it. A null `path` means "this view is not open".
 */
function useRemoteQuery<T>(client: RemoteClient, path: string | null, viewKey: number): RemoteQueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<RemoteErrorInfo | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [reloadKey, setReloadKey] = useState(0);
  const renewedFor = useRef<number | null>(null);

  useEffect(() => {
    if (!path) {
      // Remember this view generation so that opening a detail panel inside it
      // does not mint a second token.
      renewedFor.current = viewKey;
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setData(null);
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        if (renewedFor.current !== viewKey) {
          renewedFor.current = viewKey;
          await client.renew();
        }
        const result = await client.get<T>(path);
        if (!cancelled) setData(result);
      } catch (requestError) {
        if (!cancelled) setError(describeError(requestError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, path, viewKey, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  // Effects run after paint, so a freshly opened view would otherwise render an
  // empty body for one frame before `setLoading(true)` lands.
  const busy = loading || (path !== null && !data && !error);
  return { data, loading: busy, error, reload };
}

function QueryStatus({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: RemoteErrorInfo | null;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-muted)]" aria-busy="true">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在读取客户数据…
      </div>
    );
  }
  if (!error) return null;
  return (
    <div className="alert alert-error items-start">
      <CircleAlert className="h-4 w-4 shrink-0" />
      <div className="space-y-1">
        <div>{error.message}</div>
        {error.notConfigured ? (
          <div className="text-xs opacity-80">
            该实例可能刚部署完成或长时间离线。请让它成功完成一次心跳（通常 1~2 分钟）后重试。
          </div>
        ) : null}
        <button className="btn btn-xs" onClick={onRetry}>
          <RefreshCw className="h-3 w-3" />
          重试
        </button>
      </div>
    </div>
  );
}

function Pager({
  total,
  limit,
  offset,
  unit,
  onOffset,
}: {
  total: number;
  limit: number;
  offset: number;
  unit: string;
  onOffset: (next: number) => void;
}) {
  const size = Math.max(1, limit);
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages, Math.floor(offset / size) + 1);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--color-muted)]">
      <span>
        共 {total} {unit}
      </span>
      <div className="flex items-center gap-2">
        <button className="btn btn-sm" disabled={offset <= 0} onClick={() => onOffset(Math.max(0, offset - size))}>
          上一页
        </button>
        <span>
          第 {page}/{pages} 页
        </span>
        <button className="btn btn-sm" disabled={offset + size >= total} onClick={() => onOffset(offset + size)}>
          下一页
        </button>
      </div>
    </div>
  );
}

function SummaryPanel({ state }: { state: RemoteQueryState<RemoteSummaryData> }) {
  const summary = state.data?.summary;
  return (
    <>
      <QueryStatus loading={state.loading} error={state.error} onRetry={state.reload} />
      {summary ? (
        <div className="admin-stat-grid">
          {[
            { label: "问卷", value: summary.surveys },
            { label: "答卷", value: summary.responses },
            { label: "已完成答卷", value: summary.completed },
            { label: "用户", value: summary.users },
          ].map(({ label, value }) => (
            <div key={label} className="admin-stat">
              <div className="text-sm text-[var(--color-muted)]">{label}</div>
              <div className="mt-2 font-tabular-nums text-2xl font-bold">{value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function SurveysPanel({
  state,
  onOffset,
  onOpenResponses,
}: {
  state: RemoteQueryState<RemoteListData<RemoteSurvey>>;
  onOffset: (next: number) => void;
  onOpenResponses: (surveyId: number) => void;
}) {
  const data = state.data;
  return (
    <>
      <QueryStatus loading={state.loading} error={state.error} onRetry={state.reload} />
      {data ? (
        data.items.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>标题</th>
                    <th>状态</th>
                    <th>创建时间</th>
                    <th>更新时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((survey) => (
                    <tr key={survey.id} className="hover">
                      <td className="text-sm">#{survey.id}</td>
                      <td className="text-sm">
                        <div className="font-medium">{survey.title}</div>
                        {survey.description ? (
                          <div className="max-w-72 truncate text-xs opacity-50">{survey.description}</div>
                        ) : null}
                      </td>
                      <td className="text-sm">
                        {survey.status in STATUS_LABELS ? (
                          <StatusBadge status={survey.status as SurveyStatus} />
                        ) : (
                          <span className="badge badge-sm">{survey.status}</span>
                        )}
                      </td>
                      <td className="text-xs opacity-60">{formatDateTime(survey.createdAt)}</td>
                      <td className="text-xs opacity-60">{formatDateTime(survey.updatedAt)}</td>
                      <td>
                        <button className="btn btn-ghost btn-xs" onClick={() => onOpenResponses(survey.id)}>
                          看答卷
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              total={data.total}
              limit={data.limit}
              offset={data.offset}
              unit="份问卷"
              onOffset={onOffset}
            />
          </>
        ) : (
          <EmptyPanel text="该实例还没有问卷" />
        )
      ) : null}
    </>
  );
}

function respondentName(item: RemoteResponse): string {
  if (item.firstName) return item.firstName;
  if (item.username) return `@${item.username}`;
  if (item.userId !== null) return `用户 #${item.userId}`;
  return "游客（未登录）";
}

function answerText(answer: RemoteAnswer): string {
  if (answer.textValue) return answer.textValue;
  if (answer.numberValue !== null && answer.numberValue !== undefined) return String(answer.numberValue);
  if (answer.ratingValue !== null && answer.ratingValue !== undefined) return String(answer.ratingValue);
  if (answer.booleanValue !== null && answer.booleanValue !== undefined) return answer.booleanValue ? "是" : "否";
  if (answer.dateValue) return answer.dateValue;
  if (answer.timeValue) return answer.timeValue;
  if (answer.jsonValue !== null && answer.jsonValue !== undefined) {
    return typeof answer.jsonValue === "string" ? answer.jsonValue : JSON.stringify(answer.jsonValue);
  }
  return "—";
}

function ResponsesPanel({
  state,
  options,
  surveyId,
  status,
  onSurvey,
  onStatus,
  onOffset,
  detail,
  detailId,
  onDetail,
}: {
  state: RemoteQueryState<RemoteListData<RemoteResponse>>;
  options: RemoteQueryState<RemoteListData<RemoteSurvey>>;
  surveyId: string;
  status: string;
  onSurvey: (value: string) => void;
  onStatus: (value: string) => void;
  onOffset: (next: number) => void;
  detail: RemoteQueryState<RemoteResponseDetail>;
  detailId: number | null;
  onDetail: (id: number | null) => void;
}) {
  const data = state.data;
  const surveyOptions = options.data?.items ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <select className="select select-sm" value={surveyId} onChange={(event) => onSurvey(event.target.value)}>
          <option value="">全部问卷</option>
          {surveyOptions.map((survey) => (
            <option key={survey.id} value={survey.id}>
              #{survey.id} {survey.title}
            </option>
          ))}
        </select>
        <select className="select select-sm" value={status} onChange={(event) => onStatus(event.target.value)}>
          {RESPONSE_STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {options.loading ? <span className="text-xs opacity-50">正在读取问卷列表…</span> : null}
        {options.error ? <span className="text-xs text-error">问卷筛选列表加载失败</span> : null}
        {(options.data?.total ?? 0) > SURVEY_OPTION_PAGE ? (
          <span className="text-xs opacity-50">筛选列表只显示最近 {SURVEY_OPTION_PAGE} 份问卷</span>
        ) : null}
      </div>

      <QueryStatus loading={state.loading} error={state.error} onRetry={state.reload} />

      {data ? (
        data.items.length ? (
          <>
            <div className="mt-4 overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>问卷</th>
                    <th>填写者</th>
                    <th>状态</th>
                    <th>开始时间</th>
                    <th>完成时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id} className="hover">
                      <td className="text-sm">#{item.id}</td>
                      <td className="text-sm">
                        <div className="max-w-56 truncate font-medium">{item.surveyTitle ?? "（问卷已删除）"}</div>
                        <div className="text-xs opacity-50">surveyId {item.surveyId}</div>
                      </td>
                      <td className="text-sm">{respondentName(item)}</td>
                      <td className="text-sm">{RESPONSE_STATUS_LABELS[item.status] ?? item.status}</td>
                      <td className="text-xs opacity-60">{formatDateTime(item.createdAt)}</td>
                      <td className="text-xs opacity-60">
                        {item.completedAt ? formatDateTime(item.completedAt) : "—"}
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={() => onDetail(detailId === item.id ? null : item.id)}
                        >
                          {detailId === item.id ? "收起" : "详情"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={data.total} limit={data.limit} offset={data.offset} unit="份答卷" onOffset={onOffset} />
          </>
        ) : (
          <EmptyPanel text={surveyId || status ? "当前筛选下没有答卷" : "该实例还没有答卷"} />
        )
      ) : null}

      {detailId !== null ? (
        <div className="mt-4 rounded-xl border border-[var(--color-edge)] bg-[var(--surface-muted)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-semibold">
              答卷 #{detailId} 明细
              {detail.data?.response.surveyTitle ? (
                <span className="ml-2 text-sm font-normal opacity-60">{detail.data.response.surveyTitle}</span>
              ) : null}
            </h4>
            <button className="btn btn-xs" onClick={() => onDetail(null)}>
              收起
            </button>
          </div>
          <QueryStatus loading={detail.loading} error={detail.error} onRetry={detail.reload} />
          {detail.data ? (
            detail.data.answers.length ? (
              <div className="mt-3 overflow-x-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>题目</th>
                      <th>答案</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.answers.map((answer) => (
                      <tr key={answer.id}>
                        <td className="text-sm">questionId {answer.questionId}</td>
                        <td className="text-sm break-all">{answerText(answer)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs opacity-50">该实例的只读接口只返回 questionId，未附带题目标题。</p>
              </div>
            ) : (
              <p className="mt-3 text-sm opacity-60">这份答卷还没有任何作答内容。</p>
            )
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function UsersPanel({
  state,
  search,
  onSearch,
  onOffset,
}: {
  state: RemoteQueryState<RemoteListData<RemoteUser>>;
  search: string;
  onSearch: (value: string) => void;
  onOffset: (next: number) => void;
}) {
  const data = state.data;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 opacity-40" />
          <input
            className="input pl-8"
            placeholder="搜索姓名 / @用户名 / Telegram ID"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
      </div>

      <QueryStatus loading={state.loading} error={state.error} onRetry={state.reload} />

      {data ? (
        data.items.length ? (
          <>
            <div className="mt-4 overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>Telegram ID</th>
                    <th>角色</th>
                    <th>注册时间</th>
                    <th>最近启动</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => {
                    const name =
                      [item.firstName, item.lastName].filter(Boolean).join(" ") ||
                      (item.username ? `@${item.username}` : `用户 #${item.id}`);
                    const banned = item.banned === true || item.banned === 1;
                    return (
                      <tr key={item.id} className="hover">
                        <td className="text-sm">
                          <div className="font-medium">
                            {name}
                            {banned ? (
                              <span className="ml-1 rounded-full bg-[color-mix(in_srgb,var(--app-danger)_12%,var(--surface))] px-2 py-0.5 text-xs text-[var(--app-danger)]">
                                已封禁
                              </span>
                            ) : null}
                          </div>
                          {item.username && name !== `@${item.username}` ? (
                            <div className="text-xs opacity-50">@{item.username}</div>
                          ) : null}
                        </td>
                        <td className="text-sm">{item.telegramUserId}</td>
                        <td className="text-sm">{item.systemRole}</td>
                        <td className="text-xs opacity-60">{formatDateTime(item.createdAt)}</td>
                        <td className="text-xs opacity-60">
                          {item.botStartedAt ? formatDateTime(item.botStartedAt) : "—"}
                        </td>
                        <td>
                          <a className="btn btn-ghost btn-xs" href={userChatLink(item.telegramUserId)}>
                            私聊
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager total={data.total} limit={data.limit} offset={data.offset} unit="位用户" onOffset={onOffset} />
          </>
        ) : (
          <EmptyPanel text="没有匹配的用户" />
        )
      ) : null}
    </>
  );
}

export function RemoteDataViewer({
  deployment,
  onClose,
}: {
  deployment: DeploymentView;
  onClose: () => void;
}) {
  const client = useMemo(() => createRemoteClient(deployment.id), [deployment.id]);
  const [tab, setTab] = useState<RemoteTab>("summary");
  const [viewKey, setViewKey] = useState(0);
  const [surveyOffset, setSurveyOffset] = useState(0);
  const [responseOffset, setResponseOffset] = useState(0);
  const [responseSurveyId, setResponseSurveyId] = useState("");
  const [responseStatus, setResponseStatus] = useState("");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [userOffset, setUserOffset] = useState(0);
  const [userSearchInput, setUserSearchInput] = useState("");
  const [userSearch, setUserSearch] = useState("");

  // Debounce the free-text search: the instance's lookup is an unindexed LIKE
  // scan, and a keystroke should not fetch a fresh token.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setUserSearch(userSearchInput.trim());
      setUserOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [userSearchInput]);

  const open = (next: RemoteTab) => {
    setTab(next);
    setDetailId(null);
    setViewKey((key) => key + 1);
  };
  const refresh = () => {
    setDetailId(null);
    setViewKey((key) => key + 1);
  };

  const summary = useRemoteQuery<RemoteSummaryData>(client, tab === "summary" ? "/api/remote/summary" : null, viewKey);
  const surveys = useRemoteQuery<RemoteListData<RemoteSurvey>>(
    client,
    tab === "surveys" ? `/api/remote/surveys?limit=${PAGE_SIZE}&offset=${surveyOffset}` : null,
    viewKey,
  );
  // The 答卷 tab needs the survey list for its filter dropdown.
  const surveyOptions = useRemoteQuery<RemoteListData<RemoteSurvey>>(
    client,
    tab === "responses" ? `/api/remote/surveys?limit=${SURVEY_OPTION_PAGE}&offset=0` : null,
    viewKey,
  );
  const responses = useRemoteQuery<RemoteListData<RemoteResponse>>(
    client,
    tab === "responses"
      ? `/api/remote/responses?limit=${PAGE_SIZE}&offset=${responseOffset}` +
        (responseSurveyId ? `&surveyId=${responseSurveyId}` : "") +
        (responseStatus ? `&status=${responseStatus}` : "")
      : null,
    viewKey,
  );
  const users = useRemoteQuery<RemoteListData<RemoteUser>>(
    client,
    tab === "users"
      ? `/api/remote/users?limit=${PAGE_SIZE}&offset=${userOffset}` +
        (userSearch ? `&search=${encodeURIComponent(userSearch)}` : "")
      : null,
    viewKey,
  );
  const detail = useRemoteQuery<RemoteResponseDetail>(
    client,
    detailId !== null ? `/api/remote/responses/${detailId}` : null,
    viewKey,
  );

  return (
    // The shared Modal owns Escape, the scroll lock and focus; this surface
    // previously re-implemented the daisyUI modal classes, which are not
    // generated by this build (so it wasn't an overlay at all).
    <Modal open onClose={onClose} size="lg" title={`客户数据 · ${deployment.workerName}`}>
        <p className="text-sm text-[var(--color-muted)]">只读浏览 · {deployment.workerUrl ?? deployment.installationId}</p>

        <p className="mt-3 rounded-xl bg-base-200 p-3 text-xs text-[var(--color-muted)]">
          数据由浏览器直接向该客户实例读取，控制中心不中转、不缓存，且只发 GET 请求；每次打开或刷新会重新申请 5
          分钟有效的只读令牌。该实例需要至少完成一次心跳，控制中心才能签发令牌。
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              className={id === tab ? "btn btn-primary btn-sm" : "btn btn-sm"}
              onClick={() => open(id)}
            >
              {label}
            </button>
          ))}
          <button className="btn btn-sm ml-auto" onClick={refresh}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        </div>

        <div className="mt-4 max-h-[58vh] overflow-y-auto pr-1">
          {tab === "summary" ? <SummaryPanel state={summary} /> : null}
          {tab === "surveys" ? (
            <SurveysPanel
              state={surveys}
              onOffset={setSurveyOffset}
              onOpenResponses={(surveyId) => {
                setResponseSurveyId(String(surveyId));
                setResponseOffset(0);
                open("responses");
              }}
            />
          ) : null}
          {tab === "responses" ? (
            <ResponsesPanel
              state={responses}
              options={surveyOptions}
              surveyId={responseSurveyId}
              status={responseStatus}
              onSurvey={(value) => {
                setResponseSurveyId(value);
                setResponseOffset(0);
              }}
              onStatus={(value) => {
                setResponseStatus(value);
                setResponseOffset(0);
              }}
              onOffset={setResponseOffset}
              detail={detail}
              detailId={detailId}
              onDetail={setDetailId}
            />
          ) : null}
          {tab === "users" ? (
            <UsersPanel
              state={users}
              search={userSearchInput}
              onSearch={setUserSearchInput}
              onOffset={setUserOffset}
            />
          ) : null}
        </div>

        <div className="toolbar mt-4 justify-end">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
    </Modal>
  );
}
