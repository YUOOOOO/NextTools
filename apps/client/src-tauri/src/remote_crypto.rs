use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub fn random() -> String {
    let mut b = [0; 32];
    OsRng.fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}
fn bytes(s: &str) -> Result<[u8; 32], String> {
    B64.decode(s)
        .map_err(|_| "Invalid key")?
        .try_into()
        .map_err(|_| "Invalid key size".into())
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Keys {
    signing: String,
    exchange: String,
}
impl Keys {
    pub fn generate() -> Self {
        let sign = SigningKey::generate(&mut OsRng);
        let exchange = StaticSecret::random_from_rng(OsRng);
        Self {
            signing: B64.encode(sign.to_bytes()),
            exchange: B64.encode(exchange.to_bytes()),
        }
    }
    pub fn public(&self) -> Result<(String, String), String> {
        Ok((
            B64.encode(
                SigningKey::from_bytes(&bytes(&self.signing)?)
                    .verifying_key()
                    .as_bytes(),
            ),
            B64.encode(PublicKey::from(&StaticSecret::from(bytes(&self.exchange)?)).as_bytes()),
        ))
    }
    pub fn sign(&self, text: &str) -> Result<String, String> {
        Ok(B64.encode(
            SigningKey::from_bytes(&bytes(&self.signing)?)
                .sign(text.as_bytes())
                .to_bytes(),
        ))
    }
    fn cipher(&self, peer: &str) -> Result<ChaCha20Poly1305, String> {
        let shared = StaticSecret::from(bytes(&self.exchange)?)
            .diffie_hellman(&PublicKey::from(bytes(peer)?));
        if !shared.was_contributory() {
            return Err("Invalid exchange key".into());
        }
        let mut key = [0; 32];
        Hkdf::<Sha256>::new(Some(b"nexttools.e2ee.v1"), shared.as_bytes())
            .expand(b"pairwise-encryption", &mut key)
            .map_err(|_| "Key derivation failed")?;
        Ok(ChaCha20Poly1305::new((&key).into()))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub id: String,
    pub source: String,
    pub target: String,
    pub workspace: String,
    pub channel: String,
    pub operation: String,
    pub expires: u64,
    pub nonce: String,
    pub ciphertext: String,
    pub signature: String,
}
impl Envelope {
    fn header(&self) -> String {
        format!(
            "v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.channel,
            self.id,
            self.source,
            self.target,
            self.workspace,
            self.operation,
            self.expires,
            self.nonce
        )
    }
    pub fn text(&self) -> String {
        format!("{}\n{}", self.header(), self.ciphertext)
    }
    pub fn seal(
        keys: &Keys,
        source: &str,
        target: &str,
        peer: &str,
        workspace: &str,
        channel: &str,
        operation: &str,
        payload: &Value,
    ) -> Result<Self, String> {
        let mut nonce = [0; 12];
        OsRng.fill_bytes(&mut nonce);
        let mut e = Self {
            id: uuid::Uuid::new_v4().to_string(),
            source: source.into(),
            target: target.into(),
            workspace: workspace.into(),
            channel: channel.into(),
            operation: operation.into(),
            expires: now() + 25_000,
            nonce: B64.encode(nonce),
            ciphertext: String::new(),
            signature: String::new(),
        };
        let plain = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
        e.ciphertext = B64.encode(
            keys.cipher(peer)?
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &plain,
                        aad: e.header().as_bytes(),
                    },
                )
                .map_err(|_| "Encryption failed")?,
        );
        e.signature = keys.sign(&e.text())?;
        Ok(e)
    }
    pub fn open(
        &self,
        keys: &Keys,
        signing: &str,
        exchange: &str,
        target: &str,
    ) -> Result<Value, String> {
        if self.target != target
            || self.source == target
            || (self.channel != "sync" && (self.expires <= now() || self.expires > now() + 30_000))
        {
            return Err("Invalid route or expired envelope".into());
        }
        let sig = Signature::from_slice(
            &B64.decode(&self.signature)
                .map_err(|_| "Invalid signature")?,
        )
        .map_err(|_| "Invalid signature")?;
        VerifyingKey::from_bytes(&bytes(signing)?)
            .map_err(|_| "Invalid signing key")?
            .verify_strict(self.text().as_bytes(), &sig)
            .map_err(|_| "Signature rejected")?;
        let nonce: [u8; 12] = B64
            .decode(&self.nonce)
            .map_err(|_| "Invalid nonce")?
            .try_into()
            .map_err(|_| "Invalid nonce")?;
        let plain = keys
            .cipher(exchange)?
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &B64
                        .decode(&self.ciphertext)
                        .map_err(|_| "Invalid ciphertext")?,
                    aad: self.header().as_bytes(),
                },
            )
            .map_err(|_| "Decryption rejected")?;
        serde_json::from_slice(&plain).map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_signed_routes_expiry_and_tampering() {
        let a = Keys::generate();
        let b = Keys::generate();
        let (sign, ex) = a.public().unwrap();
        let (_, bex) = b.public().unwrap();
        let e = Envelope::seal(
            &a,
            "a",
            "b",
            &bex,
            "w",
            "control",
            "session.prompt",
            &serde_json::json!({"text":"private"}),
        )
        .unwrap();
        assert_eq!(e.open(&b, &sign, &ex, "b").unwrap()["text"], "private");
        assert!(e.open(&b, &sign, &ex, "c").is_err());
        let mut altered = e.clone();
        altered.workspace = "other".into();
        assert!(altered.open(&b, &sign, &ex, "b").is_err());
        altered = e.clone();
        altered.expires = 0;
        assert!(altered.open(&b, &sign, &ex, "b").is_err());
        assert!(e.open(&Keys::generate(), &sign, &ex, "b").is_err());
    }
}
