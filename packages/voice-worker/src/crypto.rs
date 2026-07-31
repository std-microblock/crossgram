//! Telegram call cryptographic primitives. Secret values never implement `Debug`.

use std::fs::File;
use std::io::Read;

use crypto_bigint::{
    Odd, U2048,
    modular::{FixedMontyForm, FixedMontyParams},
};
use sha1::{Digest as Sha1Digest, Sha1};
use sha2::Sha256;
use zeroize::Zeroize;

pub const DH_PUBLIC_BYTES: usize = 256;
pub const GA_HASH_BYTES: usize = 32;
const DH_MARGIN_BITS: u32 = 2048 - 64;
const TELEGRAM_DH_PRIME_HEX: &str = "C71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F48198A0AA7C14058229493D22530F4DBFA336F6E0AC925139543AED44CCE7C3720FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F642477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4A4A695811051907E162753B56B0F6B410DBA74D8A84B2A14B3144E0EF1284754FD17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4E418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F0D8115F635B105EE2E4E15D04B2454BF6F4FADF034B10403119CD8E3B92FCC5B";
const TELEGRAM_DH_PRIME: Odd<U2048> = Odd::from_be_hex(TELEGRAM_DH_PRIME_HEX);
const TELEGRAM_DH_PARAMS: FixedMontyParams<32> = FixedMontyParams::new(TELEGRAM_DH_PRIME);
const DH_MARGIN: U2048 = U2048::ONE.shl(DH_MARGIN_BITS);

#[derive(PartialEq, Eq)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    #[must_use]
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

pub struct DhPrivate(SecretBytes);

impl DhPrivate {
    /// Generates a full-width private exponent from the operating system CSPRNG.
    pub fn generate() -> Result<Self, CryptoError> {
        let mut bytes = [0; DH_PUBLIC_BYTES];
        if File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut bytes))
            .is_err()
        {
            bytes.zeroize();
            return Err(CryptoError::RandomnessUnavailable);
        }
        if bytes.iter().all(|byte| *byte == 0) {
            bytes.zeroize();
            return Err(CryptoError::RandomnessUnavailable);
        }
        let private = Self(SecretBytes::new(bytes.to_vec()));
        bytes.zeroize();
        Ok(private)
    }

    fn exponent(&self) -> U2048 {
        U2048::from_be_slice(self.0.as_slice())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CryptoError {
    InvalidGroup,
    InvalidPublicValue,
    RandomnessUnavailable,
    HashMismatch,
}

/// Returns Telegram's fixed, audited 2048-bit safe prime.
///
/// The protocol only accepts this exact standard safe-prime group. Equality to the
/// published Telegram constant is the safe-prime validation; accepting arbitrary
/// probable primes would permit an unaudited group.
#[must_use]
pub fn telegram_dh_prime() -> U2048 {
    TELEGRAM_DH_PRIME.get_copy()
}

pub fn validate_telegram_group(prime: &[u8], generator: u8) -> Result<(), CryptoError> {
    if generator != 3
        || prime.len() != DH_PUBLIC_BYTES
        || prime != public_bytes(&telegram_dh_prime())
    {
        return Err(CryptoError::InvalidGroup);
    }
    Ok(())
}

pub fn validate_public_value(value: &[u8]) -> Result<U2048, CryptoError> {
    if value.len() != DH_PUBLIC_BYTES {
        return Err(CryptoError::InvalidPublicValue);
    }

    let value = U2048::from_be_slice(value);
    let upper_bound = telegram_dh_prime().wrapping_sub(&DH_MARGIN);
    if value <= DH_MARGIN || value >= upper_bound {
        return Err(CryptoError::InvalidPublicValue);
    }
    Ok(value)
}

#[must_use]
pub fn public_value(private: &DhPrivate) -> [u8; DH_PUBLIC_BYTES] {
    let mut exponent = private.exponent();
    let mut generator = FixedMontyForm::<32>::new(&U2048::from(3_u8), &TELEGRAM_DH_PARAMS);
    let mut result = generator.pow_bounded_exp(&exponent, 2048);
    let mut value = result.retrieve();
    let public = public_bytes(&value);

    value.zeroize();
    result.zeroize();
    generator.zeroize();
    exponent.zeroize();
    public
}

fn public_bytes(value: &U2048) -> [u8; DH_PUBLIC_BYTES] {
    let mut encoded = value.to_be_bytes();
    let mut output = [0; DH_PUBLIC_BYTES];
    output.copy_from_slice(encoded.as_ref());
    encoded.as_mut_slice().zeroize();
    output
}

#[must_use]
pub fn ga_hash(ga: &[u8]) -> [u8; GA_HASH_BYTES] {
    let mut digest = Sha256::digest(ga);
    let mut output = [0; GA_HASH_BYTES];
    output.copy_from_slice(digest.as_ref());
    digest.as_mut_slice().zeroize();
    output
}

pub fn verify_ga_hash(ga: &[u8], expected: &[u8; GA_HASH_BYTES]) -> Result<(), CryptoError> {
    let mut hash = ga_hash(ga);
    let matches = hash == *expected;
    hash.zeroize();
    if !matches {
        return Err(CryptoError::HashMismatch);
    }
    Ok(())
}

pub fn derive_shared_key(
    private: &DhPrivate,
    peer_public: &[u8],
) -> Result<SecretBytes, CryptoError> {
    let mut peer_public = validate_public_value(peer_public)?;
    let mut exponent = private.exponent();
    let mut peer = FixedMontyForm::<32>::new(&peer_public, &TELEGRAM_DH_PARAMS);
    let mut result = peer.pow_bounded_exp(&exponent, 2048);
    let mut shared = result.retrieve();
    let mut bytes = public_bytes(&shared);
    let secret = SecretBytes::new(bytes.to_vec());

    bytes.zeroize();
    shared.zeroize();
    result.zeroize();
    peer.zeroize();
    exponent.zeroize();
    peer_public.zeroize();
    Ok(secret)
}

/// Telegram's key fingerprint is transmitted as a TL `long`: the final eight
/// SHA-1 bytes are raw little-endian bytes and may represent a negative `i64`.
#[must_use]
pub fn key_fingerprint_bytes(auth_key: &[u8]) -> [u8; 8] {
    let mut digest = Sha1::digest(auth_key);
    let mut fingerprint = [0; 8];
    fingerprint.copy_from_slice(&digest[12..20]);
    digest.as_mut_slice().zeroize();
    fingerprint
}

#[must_use]
pub fn key_fingerprint(auth_key: &[u8]) -> i64 {
    i64::from_le_bytes(key_fingerprint_bytes(auth_key))
}

pub const AES_CTR_KEY_BYTES: usize = 32;
pub const AES_CTR_IV_BYTES: usize = 16;

pub struct CallKdf {
    pub key: [u8; AES_CTR_KEY_BYTES],
    pub iv: [u8; AES_CTR_IV_BYTES],
}

impl Drop for CallKdf {
    fn drop(&mut self) {
        self.key.zeroize();
        self.iv.zeroize();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KdfRole {
    CallerToRecipient,
    RecipientToCaller,
    LegacyCallerToRecipient,
    LegacyRecipientToCaller,
}

impl KdfRole {
    const fn offset(self) -> usize {
        match self {
            Self::CallerToRecipient => 0,
            Self::RecipientToCaller => 8,
            Self::LegacyCallerToRecipient => 128,
            Self::LegacyRecipientToCaller => 136,
        }
    }
}

/// Derives call AES-256 key/IV material from a 16-byte message key and the
/// 256-byte call auth key for a protocol-defined traffic direction.
pub fn derive_call_kdf(
    message_key: &[u8; 16],
    auth_key: &SecretBytes,
    role: KdfRole,
) -> Result<CallKdf, CryptoError> {
    if auth_key.as_slice().len() != DH_PUBLIC_BYTES {
        return Err(CryptoError::InvalidPublicValue);
    }
    let x = role.offset();
    let auth_key = auth_key.as_slice();
    let mut first_input = Vec::with_capacity(52);
    first_input.extend_from_slice(message_key);
    first_input.extend_from_slice(&auth_key[x..x + 36]);
    let mut first = Sha256::digest(&first_input);
    first_input.zeroize();

    let mut second_input = Vec::with_capacity(52);
    second_input.extend_from_slice(&auth_key[x + 40..x + 76]);
    second_input.extend_from_slice(message_key);
    let mut second = Sha256::digest(&second_input);
    second_input.zeroize();

    let mut key = [0; AES_CTR_KEY_BYTES];
    key[..8].copy_from_slice(&first[..8]);
    key[8..24].copy_from_slice(&second[8..24]);
    key[24..].copy_from_slice(&first[24..]);

    let mut iv = [0; AES_CTR_IV_BYTES];
    iv[..4].copy_from_slice(&second[..4]);
    iv[4..12].copy_from_slice(&first[8..16]);
    iv[12..].copy_from_slice(&second[24..28]);

    first.as_mut_slice().zeroize();
    second.as_mut_slice().zeroize();
    Ok(CallKdf { key, iv })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALLER_EXPONENT: &str = "800102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F202122232425262728292A2B2C2D2E2F303132333435363738393A3B3C3D3E3F404142434445464748494A4B4C4D4E4F505152535455565758595A5B5C5D5E5F606162636465666768696A6B6C6D6E6F707172737475767778797A7B7C7D7E7F808182838485868788898A8B8C8D8E8F909192939495969798999A9B9C9D9E9FA0A1A2A3A4A5A6A7A8A9AAABACADAEAFB0B1B2B3B4B5B6B7B8B9BABBBCBDBEBFC0C1C2C3C4C5C6C7C8C9CACBCCCDCECFD0D1D2D3D4D5D6D7D8D9DADBDCDDDEDFE0E1E2E3E4E5E6E7E8E9EAEBECEDEEEFF0F1F2F3F4F5F6F7F8F9FAFBFCFDFEFF";
    const RECIPIENT_EXPONENT: &str = "FFFEFDFCFBFAF9F8F7F6F5F4F3F2F1F0EFEEEDECEBEAE9E8E7E6E5E4E3E2E1E0DFDEDDDCDBDAD9D8D7D6D5D4D3D2D1D0CFCECDCCCBCAC9C8C7C6C5C4C3C2C1C0BFBEBDBCBBBAB9B8B7B6B5B4B3B2B1B0AFAEADACABAAA9A8A7A6A5A4A3A2A1A09F9E9D9C9B9A999897969594939291908F8E8D8C8B8A898887868584838281807F7E7D7C7B7A797877767574737271706F6E6D6C6B6A696867666564636261605F5E5D5C5B5A595857565554535251504F4E4D4C4B4A494847464544434241403F3E3D3C3B3A393837363534333231302F2E2D2C2B2A292827262524232221201F1E1D1C1B1A191817161514131211100F0E0D0C0B0A09080706050403020100";
    const CALLER_PUBLIC: &str = "9D1938C33E913B8E2986C1124FC9523B9523A1B8820E740245AF7EB33D095EAFDBBAB63020926116FE29B094BDAA91DFE52558BF6F636454BF63468B803884EB333049E135B2F7F1973B1A6D7FD14D68BBED16F8D4CD1B9AE6D6D95575357A3DB48BD8A5E3FA98C85C8D7F7990838AD23CA344E035E728BA895EEAECD4B254DE8E6712F22C5184480F321B40BDCBBB5AF87A486DD69CC9AE911FB8D6CEF748E7D0919A18E3FD0141CD4842EF9BDBFD592ACBB47D6B790D61AC0DAEBDA732E193A9CCD82F495959FABEE4D4F5E1AA5DBB2F5C70E8B199F1882BFB63041AC1D894FEEE427F4666FFD12004A94C2216E2467E5A9ABACB319FD2EBC6CBAE49D7D4E1";
    const RECIPIENT_PUBLIC: &str = "9E55619C586D513B237A3B45820D816667069365F008152300E905D0E61D9E4E3B32F59A9BFDEDFD349BB07738CE0D5284723FC8420B26DFD3DE83B011F711040008347DCE5C5E64B774063C4ADC89D4BE59EE433481683318BE83E2CA04323F4A7F43CAB070FF9F8FDD1E716B33E3D92D3845EC8C2FA5C274B2A2C52566C5DC515300D03BD67E974D44A47CEBAB9F1A708AFFDD70D0E23E273BD2062C851BA068D18639EA0EE2AC380A18344B9F5E01FC4BF7E4A4D8A391F707B9913EB5EE7DBFAEDBBC1146A99D14D3B391F84D0BE9EC8813715B3E7225A2EE04D2515235571A1D4E7E94EA3E30A4B1CF9BAE64BCA74BC1DBBAC6F4C6D3D3523A220DD95EED";
    const SHARED_KEY: &str = "35336F0C944513AB7327845B4633E396650B84AEF446712AD93EF9D92FD6FE052C6EF2E07A3658FDBA276883BECA043DF8F4685108BB865904058D07DD0596C75FEC4852E4799FCF0C01DCF16ABE3BE45AAA7B120792BBB259E80205FFA4C4838D09319932CB97BFC62677EFFF6AADB9F1E0734F5271B5F5BB88BB107456285B3F12A589C308DC28A5F093DED79D6DBD12C555D4587AE781BFF64B98169EEB462106336A39234FDB135D03D4487C8A631186935D2D0ECB20A4D2F3364B08A662D7A56BB492AB5F513EE7A8840BA6945E11226B70C19CA3AB1626E795135AD443548E8D2823BE6DD9E706CF712F215C14B25915E419E84C28A326F636EB99D68C";

    #[test]
    fn validates_only_the_telegram_safe_prime_group() {
        let prime = public_bytes(&telegram_dh_prime());
        assert_eq!(prime.len(), DH_PUBLIC_BYTES);
        assert!(validate_telegram_group(&prime, 3).is_ok());
        assert_eq!(
            validate_telegram_group(&prime, 2),
            Err(CryptoError::InvalidGroup)
        );
        let mut wrong = prime;
        wrong[0] ^= 1;
        assert_eq!(
            validate_telegram_group(&wrong, 3),
            Err(CryptoError::InvalidGroup)
        );
    }

    #[test]
    fn preserves_leading_zero_fixed_width_encoding_for_exponent_one() {
        let mut exponent = [0; DH_PUBLIC_BYTES];
        exponent[DH_PUBLIC_BYTES - 1] = 1;
        let private = DhPrivate(SecretBytes::new(exponent.to_vec()));
        exponent.zeroize();
        let public = public_value(&private);
        assert_eq!(public.len(), DH_PUBLIC_BYTES);
        assert!(public[..DH_PUBLIC_BYTES - 1].iter().all(|byte| *byte == 0));
        assert_eq!(public[DH_PUBLIC_BYTES - 1], 3);
    }

    #[test]
    fn enforces_exact_telegram_public_value_boundaries() {
        let lower_rejected = DH_MARGIN;
        let lower_accepted = DH_MARGIN.wrapping_add(&U2048::ONE);
        let upper_rejected = telegram_dh_prime().wrapping_sub(&DH_MARGIN);
        let upper_accepted = upper_rejected.wrapping_sub(&U2048::ONE);

        assert_eq!(
            validate_public_value(&public_bytes(&lower_rejected)),
            Err(CryptoError::InvalidPublicValue)
        );
        assert!(validate_public_value(&public_bytes(&lower_accepted)).is_ok());
        assert_eq!(
            validate_public_value(&public_bytes(&upper_rejected)),
            Err(CryptoError::InvalidPublicValue)
        );
        assert!(validate_public_value(&public_bytes(&upper_accepted)).is_ok());
    }

    #[test]
    fn caller_and_recipient_derive_the_same_key_at_fixed_width() {
        let caller = DhPrivate::generate().unwrap();
        let recipient = DhPrivate::generate().unwrap();
        let ga = public_value(&caller);
        let gb = public_value(&recipient);
        assert_eq!(ga.len(), DH_PUBLIC_BYTES);
        assert_eq!(gb.len(), DH_PUBLIC_BYTES);
        let caller_key = derive_shared_key(&caller, &gb).unwrap();
        let recipient_key = derive_shared_key(&recipient, &ga).unwrap();
        assert_eq!(caller_key.as_slice(), recipient_key.as_slice());
    }

    #[test]
    fn preserves_pre_migration_full_width_dh_interoperability() {
        let caller = private_from_hex(CALLER_EXPONENT);
        let recipient = private_from_hex(RECIPIENT_EXPONENT);
        let ga = public_value(&caller);
        let gb = public_value(&recipient);

        assert_eq!(hex(&ga).to_ascii_uppercase(), CALLER_PUBLIC);
        assert_eq!(hex(&gb).to_ascii_uppercase(), RECIPIENT_PUBLIC);
        assert_eq!(
            hex(derive_shared_key(&caller, &gb).unwrap().as_slice()).to_ascii_uppercase(),
            SHARED_KEY
        );
        assert_eq!(
            hex(derive_shared_key(&recipient, &ga).unwrap().as_slice()).to_ascii_uppercase(),
            SHARED_KEY
        );
    }

    #[test]
    fn rejects_non_fixed_width_dh_public_values() {
        assert_eq!(
            validate_public_value(&[0; DH_PUBLIC_BYTES - 1]),
            Err(CryptoError::InvalidPublicValue)
        );
    }

    #[test]
    fn fingerprint_is_a_signed_little_endian_tl_long() {
        let bytes = key_fingerprint_bytes(b"abc");
        assert_eq!(bytes, [0x78, 0x50, 0xc2, 0x6c, 0x9c, 0xd0, 0xd8, 0x9d]);
        assert_eq!(key_fingerprint(b"abc"), i64::from_le_bytes(bytes));
        assert!(key_fingerprint(b"abc") < 0);
    }

    #[test]
    fn kdf_has_known_answers_for_every_role() {
        let key = SecretBytes::new((0_u8..=255).collect());
        let message_key = [0x55; 16];
        let vectors = [
            (
                KdfRole::CallerToRecipient,
                "3dc2dadfb437e3043f174ea6ac7182ed90d92c8d033b5e6a3118e175ec27fb56",
                "3946f2ca5eb9227e2024e172df234650",
            ),
            (
                KdfRole::RecipientToCaller,
                "0cdffc18f140af68f917959daf22270551b72854c9c694fd5d62221d3740a540",
                "57e5223003fd45002ff6c468756037f8",
            ),
            (
                KdfRole::LegacyCallerToRecipient,
                "fc0406bb4face5fe53dcb57c2fca564baf31292017ec0394843b1d0424617bc4",
                "49319e2f39ea490fa1a1efaf10959835",
            ),
            (
                KdfRole::LegacyRecipientToCaller,
                "476d06b15787827ab113f51f441add154ece6636e4ef46c14c1507a880b02794",
                "c0e1a0d1e12385a38e9afbedbbb5ca40",
            ),
        ];
        for (role, expected_key, expected_iv) in vectors {
            let kdf = derive_call_kdf(&message_key, &key, role).unwrap();
            assert_eq!(kdf.key.len(), AES_CTR_KEY_BYTES);
            assert_eq!(kdf.iv.len(), AES_CTR_IV_BYTES);
            assert_eq!(hex(&kdf.key), expected_key);
            assert_eq!(hex(&kdf.iv), expected_iv);
        }
    }

    fn private_from_hex(encoded: &str) -> DhPrivate {
        let mut bytes = decode_hex(encoded);
        let private = DhPrivate(SecretBytes::new(bytes.to_vec()));
        bytes.zeroize();
        private
    }

    fn decode_hex(encoded: &str) -> [u8; DH_PUBLIC_BYTES] {
        assert_eq!(encoded.len(), DH_PUBLIC_BYTES * 2);
        let mut bytes = [0; DH_PUBLIC_BYTES];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16).unwrap();
        }
        bytes
    }

    fn hex(bytes: &[u8]) -> String {
        use core::fmt::Write;

        let mut encoded = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
        }
        encoded
    }
}
