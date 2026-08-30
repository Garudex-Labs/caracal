// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package fernet implements the Fernet token format used for values
// encrypted at rest, interoperable with the cryptography library.
package fernet

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"time"
)

const version = 0x80

// DeriveKey turns a server secret into a Fernet key the same way the
// incumbent settings service does: sha256 as the KDF, base64url encoded.
func DeriveKey(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// Encrypt produces a Fernet token for msg under the 32-byte key
// (first half signing, second half encryption).
func Encrypt(key []byte, msg []byte) (string, error) {
	if len(key) != 32 {
		return "", errors.New("fernet: key must be 32 bytes")
	}
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key[16:])
	if err != nil {
		return "", err
	}
	pad := aes.BlockSize - len(msg)%aes.BlockSize
	padded := make([]byte, len(msg)+pad)
	copy(padded, msg)
	for i := len(msg); i < len(padded); i++ {
		padded[i] = byte(pad)
	}
	token := make([]byte, 0, 1+8+aes.BlockSize+len(padded)+32)
	token = append(token, version)
	var ts [8]byte
	binary.BigEndian.PutUint64(ts[:], uint64(time.Now().Unix()))
	token = append(token, ts[:]...)
	token = append(token, iv...)
	ct := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ct, padded)
	token = append(token, ct...)
	mac := hmac.New(sha256.New, key[:16])
	mac.Write(token)
	token = mac.Sum(token)
	return base64.URLEncoding.EncodeToString(token), nil
}

// Decrypt verifies and opens a Fernet token; ttl is not enforced, matching
// the incumbent's usage for at-rest values.
func Decrypt(key []byte, token string) ([]byte, error) {
	if len(key) != 32 {
		return nil, errors.New("fernet: key must be 32 bytes")
	}
	raw, err := base64.URLEncoding.DecodeString(token)
	if err != nil {
		return nil, err
	}
	if len(raw) < 1+8+aes.BlockSize+32 || raw[0] != version {
		return nil, errors.New("fernet: malformed token")
	}
	body, tag := raw[:len(raw)-32], raw[len(raw)-32:]
	mac := hmac.New(sha256.New, key[:16])
	mac.Write(body)
	if subtle.ConstantTimeCompare(mac.Sum(nil), tag) != 1 {
		return nil, errors.New("fernet: invalid signature")
	}
	iv := body[9 : 9+aes.BlockSize]
	ct := body[9+aes.BlockSize:]
	if len(ct) == 0 || len(ct)%aes.BlockSize != 0 {
		return nil, errors.New("fernet: malformed ciphertext")
	}
	block, err := aes.NewCipher(key[16:])
	if err != nil {
		return nil, err
	}
	pt := make([]byte, len(ct))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(pt, ct)
	pad := int(pt[len(pt)-1])
	if pad < 1 || pad > aes.BlockSize || pad > len(pt) {
		return nil, errors.New("fernet: bad padding")
	}
	for _, b := range pt[len(pt)-pad:] {
		if int(b) != pad {
			return nil, errors.New("fernet: bad padding")
		}
	}
	return pt[:len(pt)-pad], nil
}
