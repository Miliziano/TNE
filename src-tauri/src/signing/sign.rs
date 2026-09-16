// ─── src-tauri/src/signing/sign.rs ────────────────────────────────
// Firma e verifica del MANIFESTO dell'artifact, sui suoi BYTE CANONICI.
// (HANDOFF-firma-artifact.md §5/§9)
//
// La firma copre `canonical_value(manifest)`; poiché il manifesto contiene
// `planHash` (hash della forma canonica del piano), la firma copre
// transitivamente piano + metadati. Firma e verifica usano lo STESSO
// canonicalizzatore Rust, quindi non c'è rischio di divergenza.

use super::canonical::canonical_value;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::Value;

/// Firma il manifesto e restituisce la firma in base64.
pub fn sign_manifest(manifest: &Value, signing: &SigningKey) -> String {
    let sig = signing.sign(canonical_value(manifest).as_bytes());
    STANDARD.encode(sig.to_bytes())
}

/// Verifica la firma del manifesto contro una chiave pubblica (base64).
/// Fail-closed: qualunque anomalia (base64, lunghezze, decodifica) → false.
pub fn verify_manifest(manifest: &Value, sig_b64: &str, public_b64: &str) -> bool {
    let Ok(pk) = STANDARD.decode(public_b64) else { return false };
    let Ok(pk): Result<[u8; 32], _> = pk.try_into() else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return false };
    let Ok(sig) = STANDARD.decode(sig_b64) else { return false };
    let Ok(sig): Result<[u8; 64], _> = sig.try_into() else { return false };
    vk.verify(canonical_value(manifest).as_bytes(), &Signature::from_bytes(&sig))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kp(seed: u8) -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let pb = STANDARD.encode(sk.verifying_key().to_bytes());
        (sk, pb)
    }

    #[test]
    fn firma_e_verifica_roundtrip() {
        let (sk, pb) = kp(3);
        let m = json!({"planHash":"sha256:abc","keyId":"ed25519:x","hashAlg":"sha256","sigAlg":"ed25519"});
        let sig = sign_manifest(&m, &sk);
        assert!(verify_manifest(&m, &sig, &pb));
    }

    #[test]
    fn manomissione_del_manifesto_rifiutata() {
        let (sk, pb) = kp(3);
        let m = json!({"planHash":"sha256:abc"});
        let sig = sign_manifest(&m, &sk);
        let mut t = m.clone();
        t["planHash"] = json!("sha256:EVIL");
        assert!(!verify_manifest(&t, &sig, &pb));
    }

    #[test]
    fn chiave_sbagliata_rifiutata() {
        let (sk, _) = kp(3);
        let m = json!({"planHash":"sha256:abc"});
        let sig = sign_manifest(&m, &sk);
        let (_, other_pub) = kp(9);
        assert!(!verify_manifest(&m, &sig, &other_pub));
    }

    #[test]
    fn input_malformato_non_panica() {
        let m = json!({"a": 1});
        assert!(!verify_manifest(&m, "non-base64!!", "nope"));
    }
}
