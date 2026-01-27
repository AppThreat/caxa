package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func createMockPayload(files map[string][]byte) ([]byte, error) {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	for name, content := range files {
		header := &tar.Header{
			Name: name,
			Mode: 0600,
			Size: int64(len(content)),
		}
		if err := tw.WriteHeader(header); err != nil {
			return nil, err
		}
		if _, err := tw.Write(content); err != nil {
			return nil, err
		}
	}

	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gw.Close(); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}

func TestParseBinary(t *testing.T) {
	payloadData := []byte("mock-compressed-data")
	separator := []byte("\nCAXACAXACAXA\n")

	config := Config{
		Identifier: "test-id",
		Command:    []string{"node", "index.js"},
	}
	configData, _ := json.Marshal(config)

	var binaryBuilder bytes.Buffer
	binaryBuilder.Write([]byte("some-binary-code-here"))
	binaryBuilder.Write(separator)
	binaryBuilder.Write(payloadData)
	binaryBuilder.Write([]byte("\n"))
	binaryBuilder.Write(configData)

	parsedConfig, parsedPayload, err := parseBinary(binaryBuilder.Bytes())
	if err != nil {
		t.Fatalf("parseBinary failed: %v", err)
	}

	if parsedConfig.Identifier != "test-id" {
		t.Errorf("Expected identifier 'test-id', got '%s'", parsedConfig.Identifier)
	}
	if !bytes.Equal(parsedPayload, payloadData) {
		t.Errorf("Payload mismatch")
	}
}

func TestExtract_Parallel_And_LargeFiles(t *testing.T) {
	smallContent := []byte("small-file")

	largeSize := 1024 * 1024 + 100
	largeContent := make([]byte, largeSize)
	rand.Read(largeContent)

	files := map[string][]byte{
		"small.txt":       smallContent,
		"subdir/test.txt": smallContent,
		"large.bin":       largeContent,
	}

	payload, err := createMockPayload(files)
	if err != nil {
		t.Fatalf("Failed to create mock payload: %v", err)
	}

	destDir, err := os.MkdirTemp("", "caxa-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(destDir)

	if err := extract(payload, destDir); err != nil {
		t.Fatalf("extract failed: %v", err)
	}

	checkFile := func(path string, expected []byte) {
		content, err := os.ReadFile(filepath.Join(destDir, path))
		if err != nil {
			t.Errorf("Failed to read extracted file %s: %v", path, err)
			return
		}
		if !bytes.Equal(content, expected) {
			t.Errorf("Content mismatch for %s", path)
		}
	}

	checkFile("small.txt", smallContent)
	checkFile("subdir/test.txt", smallContent)
	checkFile("large.bin", largeContent)
}

func TestExtract_ZipSlip_Security(t *testing.T) {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	header := &tar.Header{
		Name: "../../../etc/passwd",
		Mode: 0600,
		Size: int64(4),
	}
	tw.WriteHeader(header)
	tw.Write([]byte("root"))
	tw.Close()
	gw.Close()

	destDir, _ := os.MkdirTemp("", "caxa-security-test-*")
	defer os.RemoveAll(destDir)

	err := extract(buf.Bytes(), destDir)
	if err == nil {
		t.Fatal("Expected extract to fail on ZipSlip attempt, but it succeeded")
	}

	if !strings.Contains(err.Error(), "illegal file path") {
		t.Errorf("Expected 'illegal file path' error, got: %v", err)
	}
}