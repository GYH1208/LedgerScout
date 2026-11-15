async function request(path, body, signal) {
  const response = await fetch(path, {
    signal,
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-ledgerscout-client": "web",
          },
          body: JSON.stringify(body),
        }),
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("真实服务尚未连接，请启动本地真实查询服务。");
  }
  if (!response.ok) throw new Error(value.error || "本地请求失败");
  return value;
}
export const getState = (signal) => request("/api/state", undefined, signal);
export const startRun = (body) => request("/api/runs", body);
export const cancelRun = (id) =>
  request(`/api/runs/${encodeURIComponent(id)}/cancel`, {});
export const getEvidence = (jobId, queryId, offset = 0) =>
  request(
    `/api/evidence/${encodeURIComponent(jobId)}/${encodeURIComponent(
      queryId
    )}?offset=${offset}`
  );
