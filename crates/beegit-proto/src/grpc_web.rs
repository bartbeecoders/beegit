//! Client side of the gRPC-Web transport ([`Endpoint::GrpcWeb`](crate::Endpoint::GrpcWeb);
//! amendment B-2).
//!
//! gRPC-Web keeps the gRPC message framing (`flag u8 | length u32 BE | payload`) and moves the
//! trailers into the body as one more frame with flag `0x80` whose payload is
//! `name:value\r\n` lines. [`request`] marks a plain gRPC request as gRPC-Web (the body is
//! unchanged: a request has no trailers), and [`WebBody`] turns a gRPC-Web response body back
//! into plain gRPC framing followed by a real trailers frame, so tonic's decoder and
//! [`EpochCapture`](crate::EpochCapture) work as with HTTP/2 trailers.
//!
//! The decoder buffers until a frame is complete, so it is independent of how a proxy
//! re-chunks the body (tonic-web 0.14's client decoder loses the trailers when the last
//! message and the trailer frame arrive in the same chunk, which Cloudflare does).

use bytes::{Buf, Bytes, BytesMut};
use http::{HeaderMap, HeaderName, HeaderValue};
use http_body::{Body, Frame, SizeHint};
use pin_project_lite::pin_project;
use std::pin::Pin;
use std::task::{Context, Poll, ready};

/// `content-type` of a binary gRPC-Web request.
pub(crate) const CONTENT_TYPE: &str = "application/grpc-web+proto";
/// gRPC frame header: flag byte plus big-endian length.
const HEADER_LEN: usize = 5;
/// Flag bit of the trailers frame.
const TRAILERS_BIT: u8 = 0x80;

/// Turn a plain gRPC request into a gRPC-Web one: same body, gRPC-Web content type, HTTP/2.
pub(crate) fn request<B>(mut req: http::Request<B>) -> http::Request<B> {
    let h = req.headers_mut();
    h.insert(
        http::header::CONTENT_TYPE,
        HeaderValue::from_static(CONTENT_TYPE),
    );
    h.insert("x-grpc-web", HeaderValue::from_static("1"));
    h.remove(http::header::TE);
    *req.version_mut() = http::Version::HTTP_2;
    req
}

/// Whether a response is gRPC-Web (otherwise it is passed through untouched, e.g. a
/// trailers-only error or a proxy's own error page).
pub(crate) fn is_grpc_web(headers: &HeaderMap) -> bool {
    headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/grpc-web"))
}

/// The gRPC status for an HTTP error answered by something other than the server (a proxy's
/// own error page, e.g. Cloudflare's 413 for a request body above its limit), following the
/// gRPC HTTP-to-status mapping, with RESOURCE_EXHAUSTED for 413.
pub(crate) fn proxy_status(status: http::StatusCode) -> tonic::Status {
    use tonic::Code;
    let code = match status.as_u16() {
        400 => Code::Internal,
        401 => Code::Unauthenticated,
        403 => Code::PermissionDenied,
        404 => Code::Unimplemented,
        413 => Code::ResourceExhausted,
        429 | 502 | 503 | 504 => Code::Unavailable,
        _ => Code::Unknown,
    };
    let hint = if status == http::StatusCode::PAYLOAD_TOO_LARGE {
        " (the request exceeds a proxy's body size limit, e.g. Cloudflare's ~100 MiB)"
    } else {
        ""
    };
    tonic::Status::new(
        code,
        format!("HTTP {status} from a proxy in front of the server{hint}"),
    )
}

pin_project! {
    /// A gRPC-Web response body decoded to plain gRPC data frames plus a trailers frame.
    pub struct WebBody<B> {
        #[pin]
        inner: B,
        buf: BytesMut,
        trailers: Option<HeaderMap>,
        inner_done: bool,
    }
}

impl<B> WebBody<B> {
    /// Decode `inner`.
    pub fn new(inner: B) -> Self {
        WebBody {
            inner,
            buf: BytesMut::new(),
            trailers: None,
            inner_done: false,
        }
    }
}

/// Parse the payload of a trailers frame (`name:value\r\n`…).
fn parse_trailers(payload: &[u8]) -> Result<HeaderMap, tonic::Status> {
    let mut map = HeaderMap::new();
    for line in payload.split(|&b| b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let colon = line
            .iter()
            .position(|&b| b == b':')
            .ok_or_else(|| tonic::Status::internal("malformed gRPC-Web trailer line"))?;
        let name = HeaderName::from_bytes(line[..colon].trim_ascii())
            .map_err(|_| tonic::Status::internal("invalid gRPC-Web trailer name"))?;
        let value = HeaderValue::from_bytes(line[colon + 1..].trim_ascii())
            .map_err(|_| tonic::Status::internal("invalid gRPC-Web trailer value"))?;
        map.append(name, value);
    }
    Ok(map)
}

impl<B> WebBody<B> {
    /// Take every complete message frame at the front of the buffer, and the trailers frame if
    /// it is complete. Returns the message bytes (plain gRPC framing).
    fn drain(
        buf: &mut BytesMut,
        trailers: &mut Option<HeaderMap>,
    ) -> Result<Option<Bytes>, tonic::Status> {
        let mut msgs = 0usize;
        loop {
            let rest = &buf[msgs..];
            if rest.len() < HEADER_LEN {
                break;
            }
            let flag = rest[0];
            let len = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
            if rest.len() < HEADER_LEN + len {
                break;
            }
            if flag & TRAILERS_BIT != 0 {
                let mut out = buf.split_to(msgs);
                buf.advance(HEADER_LEN);
                let payload = buf.split_to(len);
                let parsed = parse_trailers(&payload)?;
                match trailers {
                    Some(t) => t.extend(parsed),
                    None => *trailers = Some(parsed),
                }
                if !buf.is_empty() {
                    return Err(tonic::Status::internal(
                        "data after the gRPC-Web trailers frame",
                    ));
                }
                return Ok((!out.is_empty()).then(|| out.split().freeze()));
            }
            msgs += HEADER_LEN + len;
        }
        Ok((msgs > 0).then(|| buf.split_to(msgs).freeze()))
    }
}

impl<B> Body for WebBody<B>
where
    B: Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    type Data = Bytes;
    type Error = tonic::Status;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let mut this = self.project();
        loop {
            if let Some(data) = Self::drain(this.buf, this.trailers)? {
                return Poll::Ready(Some(Ok(Frame::data(data))));
            }
            if *this.inner_done {
                if !this.buf.is_empty() {
                    return Poll::Ready(Some(Err(tonic::Status::internal(
                        "truncated gRPC-Web response body",
                    ))));
                }
                return Poll::Ready(this.trailers.take().map(|t| Ok(Frame::trailers(t))));
            }
            match ready!(this.inner.as_mut().poll_frame(cx)) {
                Some(Ok(frame)) => match frame.into_data() {
                    Ok(data) => this.buf.extend_from_slice(&data),
                    // Real HTTP trailers (a proxy that keeps them): merge.
                    Err(frame) => {
                        if let Ok(t) = frame.into_trailers() {
                            match this.trailers.as_mut() {
                                Some(cur) => cur.extend(t),
                                None => *this.trailers = Some(t),
                            }
                        }
                    }
                },
                Some(Err(e)) => {
                    let e: Box<dyn std::error::Error + Send + Sync> = e.into();
                    return Poll::Ready(Some(Err(tonic::Status::from_error(e))));
                }
                None => *this.inner_done = true,
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner_done && self.buf.is_empty() && self.trailers.is_none()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use http_body_util::BodyExt as _;

    fn frame(flag: u8, payload: &[u8]) -> Vec<u8> {
        let mut v = vec![flag];
        v.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_be_bytes());
        v.extend_from_slice(payload);
        v
    }

    /// A body delivering `bytes` in the given chunk sizes.
    fn chunked(bytes: &[u8], sizes: &[usize]) -> impl Body<Data = Bytes, Error = std::io::Error> {
        let mut chunks = Vec::new();
        let mut rest = bytes;
        let mut i = 0;
        while !rest.is_empty() {
            let n = sizes[i % sizes.len()].min(rest.len()).max(1);
            chunks.push(Ok::<_, std::io::Error>(Frame::data(
                Bytes::copy_from_slice(&rest[..n]),
            )));
            rest = &rest[n..];
            i += 1;
        }
        // An empty END_STREAM data frame, as Cloudflare sends.
        chunks.push(Ok(Frame::data(Bytes::new())));
        http_body_util::StreamBody::new(futures::stream::iter(chunks))
    }

    async fn decode(bytes: &[u8], sizes: &[usize]) -> (Vec<u8>, Option<HeaderMap>) {
        let collected = WebBody::new(chunked(bytes, sizes)).collect().await.unwrap();
        let trailers = collected.trailers().cloned();
        (collected.to_bytes().to_vec(), trailers)
    }

    #[tokio::test]
    async fn any_chunking_yields_messages_then_trailers() {
        let m1 = frame(0, b"first message");
        let m2 = frame(0, &[7u8; 300]);
        let t = frame(
            TRAILERS_BIT,
            b"grpc-status:0\r\nbeegit-tier: server\r\nbeegit-policy-epoch:42\r\n",
        );
        let wire = [m1.clone(), m2.clone(), t].concat();
        let want = [m1, m2].concat();
        // One chunk (what broke tonic-web through Cloudflare), every byte separately, and
        // chunk sizes that split headers and payloads at every offset.
        let mut cases: Vec<Vec<usize>> = vec![vec![wire.len()], vec![1]];
        cases.extend((2..=23).map(|n| vec![n]));
        cases.push(vec![3, 17, 1, 250]);
        for sizes in cases {
            let (data, trailers) = decode(&wire, &sizes).await;
            assert_eq!(data, want, "chunks {sizes:?}");
            let t = trailers.unwrap_or_else(|| panic!("no trailers for chunks {sizes:?}"));
            assert_eq!(t["grpc-status"], "0");
            assert_eq!(t["beegit-tier"], "server");
            assert_eq!(t["beegit-policy-epoch"], "42");
        }
    }

    #[tokio::test]
    async fn error_status_and_message_survive() {
        let wire = frame(
            TRAILERS_BIT,
            b"grpc-status:5\r\ngrpc-message:no%20such%20path\r\n",
        );
        let (data, t) = decode(&wire, &[wire.len()]).await;
        assert!(data.is_empty());
        let t = t.unwrap();
        assert_eq!(t["grpc-status"], "5");
        assert_eq!(t["grpc-message"], "no%20such%20path");
    }

    #[tokio::test]
    async fn truncated_body_is_an_error() {
        let wire = frame(0, b"partial message");
        let body = WebBody::new(chunked(&wire[..wire.len() - 3], &[4]));
        assert!(body.collect().await.is_err());
    }

    #[test]
    fn proxy_errors_map_to_grpc_codes() {
        let s = proxy_status(http::StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(s.code(), tonic::Code::ResourceExhausted);
        assert!(s.message().contains("413"), "{}", s.message());
        assert_eq!(
            proxy_status(http::StatusCode::BAD_GATEWAY).code(),
            tonic::Code::Unavailable
        );
        assert_eq!(
            proxy_status(http::StatusCode::FORBIDDEN).code(),
            tonic::Code::PermissionDenied
        );
    }

    #[test]
    fn request_is_marked_grpc_web_over_http2() {
        let req = http::Request::builder()
            .version(http::Version::HTTP_11)
            .header("content-type", "application/grpc")
            .header("te", "trailers")
            .body(())
            .unwrap();
        let req = request(req);
        assert_eq!(req.version(), http::Version::HTTP_2);
        assert_eq!(req.headers()["content-type"], CONTENT_TYPE);
        assert!(req.headers().get("te").is_none());
        assert!(is_grpc_web(&HeaderMap::from_iter([(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/grpc-web+proto"),
        )])));
    }
}
