// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the additive extra-CA trust roots used by STS egress TLS.

package internal

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func selfSignedCAPEM(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Northstar Internal CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func TestLoadExtraCARootsUnsetKeepsSystemTrust(t *testing.T) {
	if pool := loadExtraCARoots(""); pool != nil {
		t.Fatal("empty path must leave the default system pool in place")
	}
}

func TestLoadExtraCARootsMissingFileKeepsSystemTrust(t *testing.T) {
	if pool := loadExtraCARoots(filepath.Join(t.TempDir(), "absent.pem")); pool != nil {
		t.Fatal("a missing bundle file must leave the default system pool in place")
	}
}

func TestLoadExtraCARootsAppendsPrivateCA(t *testing.T) {
	path := filepath.Join(t.TempDir(), "extra-ca.pem")
	if err := os.WriteFile(path, selfSignedCAPEM(t), 0o600); err != nil {
		t.Fatalf("write bundle: %v", err)
	}
	pool := loadExtraCARoots(path)
	if pool == nil {
		t.Fatal("a readable bundle must produce an augmented pool")
	}
	system, err := x509.SystemCertPool()
	if err == nil && pool.Equal(system) {
		t.Fatal("augmented pool must differ from the bare system pool")
	}
}

func TestLoadExtraCARootsGarbageFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "extra-ca.pem")
	if err := os.WriteFile(path, []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("write bundle: %v", err)
	}
	pool := loadExtraCARoots(path)
	if pool == nil {
		t.Fatal("an unparseable bundle must fail closed, not fall back to system trust")
	}
	system, err := x509.SystemCertPool()
	if err == nil && pool.Equal(system) {
		t.Fatal("an unparseable bundle must not silently keep system trust")
	}
}
