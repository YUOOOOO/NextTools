//! Fixed AgentHub account routes and bounded response decoding.
use super::NetworkError;
use crate::network_diagnostics::{error_category, RequestDiagnostic};
use serde_json::Value;
use std::time::Duration;

pub(crate) enum AccountOperation {
    IdentityState(String),
    Identity,
    Certificate,
    Rotate,
    Challenge,
    Current,
    Jwks,
    Revoke,
    RevokeState,
}
impl AccountOperation {
    pub(crate) fn request(&self) -> Result<(reqwest::Method, String, bool), NetworkError> {
        let (method, path, authenticated) = match self {
            Self::IdentityState(device_id) => {
                let canonical = uuid::Uuid::parse_str(device_id)
                    .map_err(|_| NetworkError::new("DEVICE_ID_INVALID"))?;
                if canonical.to_string() != *device_id {
                    return Err(NetworkError::new("DEVICE_ID_INVALID"));
                }
                (
                    reqwest::Method::GET,
                    format!("/api/agent-network/identity/state?deviceId={device_id}"),
                    true,
                )
            }
            Self::Identity => (
                reqwest::Method::POST,
                "/api/agent-network/identity".into(),
                true,
            ),
            Self::Certificate => (
                reqwest::Method::POST,
                "/api/agent-network/certificate".into(),
                true,
            ),
            Self::Rotate => (
                reqwest::Method::POST,
                "/api/agent-network/identity/rotate".into(),
                true,
            ),
            Self::Challenge => (
                reqwest::Method::POST,
                "/api/agent-network/challenge".into(),
                true,
            ),
            Self::Current => (
                reqwest::Method::POST,
                "/api/agent-network/identity/current".into(),
                true,
            ),
            Self::Revoke => (
                reqwest::Method::POST,
                "/api/agent-network/revoke".into(),
                true,
            ),
            Self::RevokeState => (
                reqwest::Method::POST,
                "/api/agent-network/revoke-state".into(),
                true,
            ),
            Self::Jwks => (
                reqwest::Method::GET,
                "/api/agent-network/jwks".into(),
                false,
            ),
        };
        Ok((method, path, authenticated))
    }
}


fn account_body_failure(
    status: reqwest::StatusCode,
    retry_after: Option<Duration>,
    successful_response_error: NetworkError,
) -> NetworkError {
    let mut error = if status.is_success() {
        successful_response_error
    } else {
        NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", status.as_u16())
    };
    error.retry_after = retry_after;
    error
}
pub(crate) async fn read_account_response_body(
    response: &mut reqwest::Response,
    diagnostic: &RequestDiagnostic,
) -> Result<Vec<u8>, NetworkError> {
    let status = response.status();
    let retry_after = crate::agent_network::reconnect::retry_after(response);
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        diagnostic.failure("body", error_category(&error), Some(status.as_u16()), None);
        account_body_failure(
            status,
            retry_after,
            NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", 503),
        )
    })? {
        if bytes.len() + chunk.len() > 65_536 {
            diagnostic.failure("body", "size", Some(status.as_u16()), None);
            return Err(account_body_failure(
                status,
                retry_after,
                NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID"),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
// A non-JSON edge response remains an HTTP failure, not credential revocation.
pub(crate) fn decode_account_response(
    status: reqwest::StatusCode,
    bytes: &[u8],
    retry_after: Option<Duration>,
) -> Result<Value, NetworkError> {
    serde_json::from_slice(bytes).map_err(|_| {
        let mut error = if status.is_success() {
            NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID")
        } else {
            NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", status.as_u16())
        };
        error.retry_after = retry_after;
        error
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn bounded_account_body_reader_preserves_edge_status_and_delay() {
        let diagnostic = RequestDiagnostic::new(
            "network-account",
            &reqwest::Method::GET,
            "/api/agent-network/jwks",
        );
        for status in [429, 503, 200] {
            for oversized in [false, true] {
                let bytes = if oversized {
                    vec![b'x'; 65_537]
                } else {
                    b"truncated".to_vec()
                };
                let (mut response, server) =
                    crate::network_diagnostics::test_response(status, bytes, !oversized).await;
                let error = read_account_response_body(&mut response, &diagnostic)
                    .await
                    .unwrap_err();
                drop(response);
                server.join().unwrap();
                if status == 200 {
                    assert_eq!(
                        error.code,
                        if oversized {
                            "NETWORK_ACCOUNT_RESPONSE_INVALID"
                        } else {
                            "NETWORK_ACCOUNT_UNAVAILABLE"
                        }
                    );
                    assert_eq!(error.retryable, !oversized);
                    assert_eq!(error.retry_after, None);
                } else {
                    assert_eq!(error.code, "NETWORK_ACCOUNT_UNAVAILABLE");
                    assert!(error.retryable);
                    assert_eq!(error.retry_after, Some(Duration::from_secs(45)));
                }
            }
        }
        let (mut response, server) =
            crate::network_diagnostics::test_response(200, vec![b'x'; 65_536], false).await;
        assert_eq!(
            read_account_response_body(&mut response, &diagnostic)
                .await
                .unwrap()
                .len(),
            65_536
        );
        server.join().unwrap();
    }

    #[test]
    fn malformed_edge_errors_never_claim_auth_revocation() {
        for status in [401, 403, 429, 500, 502, 503] {
            for bytes in [b"".as_slice(), b"<html>edge unavailable</html>".as_slice()] {
                let error = decode_account_response(
                    reqwest::StatusCode::from_u16(status).unwrap(),
                    bytes,
                    Some(Duration::from_secs(30)),
                )
                .err()
                .unwrap();
                assert_eq!(error.code, "NETWORK_ACCOUNT_UNAVAILABLE");
                assert_eq!(error.retryable, status == 429 || status >= 500);
                assert_eq!(error.retry_after, Some(Duration::from_secs(30)));
            }
        }
        assert_eq!(
            decode_account_response(reqwest::StatusCode::OK, b"", None)
                .err()
                .unwrap()
                .code,
            "NETWORK_ACCOUNT_RESPONSE_INVALID"
        );
        let envelope = decode_account_response(
            reqwest::StatusCode::UNAUTHORIZED,
            br#"{"success":false,"code":"NOT_AUTHENTICATED"}"#,
            None,
        )
        .unwrap();
        assert_eq!(envelope["code"], "NOT_AUTHENTICATED");
    }
}
