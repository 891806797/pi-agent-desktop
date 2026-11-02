#[cfg(test)]
mod tests {
    #[test]
    fn only_api_paths() {
        for p in [
            "https://evil/api",
            "//evil/api",
            "/api/../secret",
            "/api/%2e%2e/secret",
            "/api/a%2fb",
            "/api\\foo",
            "/apiary",
        ] {
            assert!(super::validate_path(p).is_err(), "{p}");
        }
        assert!(super::validate_path("/api/sessions?q=a%20b").is_ok());
    }
    #[test]
    fn sse_split_unicode_and_multiline() {
        let mut p = super::SseParser::default();
        let bytes = "event: message\r\ndata: 中文\r\ndata: two\r\nid: 9\r\n\r\n".as_bytes();
        let mut frames = Vec::new();
        for b in bytes {
            frames.extend(p.push(&[*b]).unwrap());
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data.as_deref(), Some("中文\ntwo"));
        assert_eq!(frames[0].last_event_id.as_deref(), Some("9"));
    }
}
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event_id: Option<String>,
}
#[derive(Deserialize)]
pub struct Request {
    pub path: String,
    pub method: String,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
}
#[derive(Serialize)]
pub struct Response {
    pub status: u16,
    pub body: String,
}
pub fn validate_path(path: &str) -> Result<(), String> {
    let pathname = path.split('?').next().unwrap_or("");
    if !(pathname == "/api" || pathname.starts_with("/api/"))
        || path.contains(['\\', '#', '\r', '\n', '\0'])
    {
        return Err("仅允许 sidecar /api 路径".into());
    }
    // Encoded separators and dots are rejected before URL normalization can change routing.
    let low = pathname.to_ascii_lowercase();
    if low.contains('%') || pathname.split('/').any(|s| s == "." || s == "..") {
        return Err("无效 API 路径".into());
    }
    Ok(())
}
// Requests may contain up to 128 MiB; their SSE echo also includes JSON framing.
const MAX_SSE_FRAME_BYTES: usize = 256 * 1024 * 1024;
pub struct SseParser {
    buffer: Vec<u8>,
    data: Vec<String>,
    event: String,
    id: Option<String>,
    size: usize,
    scanned: usize,
    limit: usize,
}
impl Default for SseParser {
    fn default() -> Self {
        Self {
            buffer: Vec::new(),
            data: Vec::new(),
            event: String::new(),
            id: None,
            size: 0,
            scanned: 0,
            limit: MAX_SSE_FRAME_BYTES,
        }
    }
}
impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut consumed = 0;
        while let Some(relative) = self.buffer[self.scanned..].iter().position(|b| *b == b'\n') {
            let end = self.scanned + relative;
            let line = std::str::from_utf8(&self.buffer[consumed..end])
                .map_err(|_| "SSE UTF-8 无效")?
                .trim_end_matches('\r');
            self.size += line.len();
            if self.size > self.limit {
                return Err("SSE 帧超过限制".into());
            }
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push(Frame {
                        name: if self.event.is_empty() {
                            "message".into()
                        } else {
                            std::mem::take(&mut self.event)
                        },
                        data: Some(self.data.join("\n")),
                        last_event_id: self.id.clone(),
                    });
                }
                self.data.clear();
                self.event.clear();
                self.size = 0;
            } else {
                let (field, value) = line.split_once(':').unwrap_or((line, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "data" => self.data.push(value.into()),
                    "event" => self.event = value.into(),
                    "id" if !value.contains('\0') => self.id = Some(value.into()),
                    _ => {}
                }
            }
            consumed = end + 1;
            self.scanned = consumed;
        }
        self.scanned = self.buffer.len() - consumed;
        if consumed > 0 {
            self.buffer.drain(..consumed);
        }
        if self.buffer.len() + self.size > self.limit {
            return Err("SSE 帧超过限制".into());
        }
        Ok(out)
    }
}
#[cfg(test)]
mod large_sse {
    use super::*;
    #[test]
    fn legal_large_event_survives_chunks() {
        let text = format!(
            "event: user_message\ndata: {}\n\n",
            "a".repeat(9 * 1024 * 1024)
        );
        let mut parser = SseParser::default();
        let mut frames = Vec::new();
        for chunk in text.as_bytes().chunks(64 * 1024) {
            frames.extend(parser.push(chunk).unwrap());
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data.as_ref().unwrap().len(), 9 * 1024 * 1024);
    }
    #[test]
    fn oversized_frame_is_explicit_error() {
        let mut parser = SseParser {
            limit: 32,
            ..Default::default()
        };
        assert!(parser
            .push(b"data: 0123456789012345678901234567890123456789")
            .is_err());
    }
}

pub async fn forward(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    request: &Request,
) -> Result<reqwest::Response, String> {
    validate_path(&request.path)?;
    let method =
        reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| "无效 HTTP 方法")?;
    if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(&method.as_str()) {
        return Err("不支持 HTTP 方法".into());
    }
    let mut req = client
        .request(method, format!("{url}{}", request.path))
        .header("x-pi-desktop-token", token)
        .timeout(std::time::Duration::from_secs(120));
    if let Some(headers) = &request.headers {
        for (key, value) in headers {
            if ["x-session-id", "x-workspace-dir"].contains(&key.to_ascii_lowercase().as_str()) {
                req = req.header(key, value);
            }
        }
    }
    if let Some(body) = &request.body {
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.clone());
    }
    req.send().await.map_err(|_| "后端请求失败".into())
}
#[cfg(test)]
mod http_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn real_post_preserves_json_and_filters_secrets() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 1024];
                let n = socket.read(&mut chunk).await.unwrap();
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let len: usize = headers
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|v| v.parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let request = Request {
            path: "/api/auth/login".into(),
            method: "POST".into(),
            body: Some(r#"{"username":"中文","password":"test"}"#.into()),
            headers: Some(HashMap::from([
                ("Cookie".into(), "forbidden".into()),
                ("x-pi-desktop-token".into(), "evil".into()),
                ("x-session-id".into(), "session".into()),
            ])),
        };
        forward(
            &reqwest::Client::new(),
            &format!("http://{address}"),
            "owned-token",
            &request,
        )
        .await
        .unwrap();
        let wire = server.await.unwrap();
        assert_eq!(
            wire.split_once("\r\n\r\n").unwrap().1,
            request.body.unwrap()
        );
        assert!(wire.contains("x-pi-desktop-token: owned-token"));
        assert!(!wire.contains("evil"));
        assert!(!wire.contains("forbidden"));
    }
}

#[cfg(test)]
mod frame_contract {
    #[test]
    fn network_error_has_no_data() {
        assert_eq!(
            serde_json::to_value(super::Frame {
                name: "error".into(),
                data: None,
                last_event_id: None
            })
            .unwrap(),
            serde_json::json!({"name":"error"})
        );
    }
}

pub fn is_session_read(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    let parts = path.split('/').collect::<Vec<_>>();
    parts.len() == 5
        && parts[1] == "api"
        && parts[2] == "sessions"
        && !parts[3].is_empty()
        && parts[4] == "read"
}
#[cfg(test)]
mod visibility_boundary {
    #[test]
    fn only_session_read_mutations_are_guarded() {
        assert!(super::is_session_read("/api/sessions/a/read"));
        assert!(super::is_session_read("/api/sessions/a/read?x=1"));
        for path in [
            "/api/sessions",
            "/api/sessions/a",
            "/api/session/read",
            "/api/sessions//read",
            "/api/sessions/a/read/extra",
        ] {
            assert!(!super::is_session_read(path));
        }
    }
}
