// smoketest exercises the hotpotato server end-to-end via signed API calls.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
)

func must[T any](v T, err error) T {
	if err != nil {
		log.Fatal(err)
	}
	return v
}

type signer struct {
	priv ed25519.PrivateKey
	pub  string
}

func newSigner() *signer {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	return &signer{priv: priv, pub: "ed25519:" + hex.EncodeToString(pub)}
}

func (s *signer) sign(msg string) string {
	return hex.EncodeToString(ed25519.Sign(s.priv, []byte(msg)))
}

var base = "http://localhost:8765"

func post(path string, body any) (int, []byte) {
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	resp := must(http.Post(base+path, "application/json", &buf))
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func get(path string) (int, []byte) {
	resp := must(http.Get(base + path))
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func happyPath() {
	log.Println("=== happy path: 5 hops ===")
	originator := newSigner()
	rootURL := "sia://fake-origin#aaa"
	archiveURL := "sia://fake-origin-archive#aaa"
	rootHash := "deadbeef"
	sig := originator.sign("chain:create:" + rootURL + ":" + archiveURL + ":" + rootHash)
	code, body := post("/api/chain", map[string]string{
		"holder_pubkey": originator.pub,
		"holder_name":   "Originator",
		"share_url":     rootURL,
		"archive_url":   archiveURL,
		"root_hash":     rootHash,
		"signature":     sig,
	})
	if code != 200 {
		log.Fatalf("create chain failed: %d %s", code, body)
	}
	var c struct {
		ChainID   string `json:"chain_id"`
		RootHopID string `json:"root_hop_id"`
		PassHopID string `json:"pass_hop_id"`
		PassLink  string `json:"pass_link"`
	}
	json.Unmarshal(body, &c)
	log.Printf("  chain=%s root=%s pass=%s", c.ChainID, c.RootHopID, c.PassHopID)

	currentHop := c.PassHopID
	const chainMax = 5
	for i := 1; i < chainMax; i++ {
		heir := newSigner()
		log.Printf("  hop %d: %s claiming %s", i, heir.pub[:14], currentHop[:8])

		// sign-init
		code, body = post("/api/hop/"+currentHop+"/sign-init", nil)
		if code != 200 {
			log.Fatalf("sign-init: %d %s", code, body)
		}
		var ni struct{ Nonce string `json:"nonce"` }
		json.Unmarshal(body, &ni)

		// sign
		acceptSig := heir.sign("accept:" + currentHop + ":" + ni.Nonce)
		code, body = post("/api/hop/"+currentHop+"/sign", map[string]string{
			"pubkey":    heir.pub,
			"name":      fmt.Sprintf("Heir%d", i),
			"nonce":     ni.Nonce,
			"signature": acceptSig,
		})
		if code != 200 {
			log.Fatalf("sign: %d %s", code, body)
		}

		// pass
		newURL := fmt.Sprintf("sia://hop%d#%d", i, i)
		newArchive := fmt.Sprintf("sia://hop%d-archive#%d", i, i)
		passSig := heir.sign("pass:" + currentHop + ":" + newURL + ":" + newArchive)
		code, body = post("/api/hop/"+currentHop+"/pass", map[string]string{
			"share_url":   newURL,
			"archive_url": newArchive,
			"signature":   passSig,
		})
		if code != 200 {
			log.Fatalf("pass: %d %s", code, body)
		}
		var pr struct {
			NextHopID string `json:"next_hop_id"`
			NextLink  string `json:"next_link"`
			ChainWon  bool   `json:"chain_won"`
		}
		json.Unmarshal(body, &pr)
		if i == chainMax-1 {
			if !pr.ChainWon {
				log.Fatalf("expected chain_won at hop %d, got %s", i, body)
			}
			log.Printf("  hop %d passed → chain WON", i)
		} else {
			currentHop = pr.NextHopID
		}
	}

	// Verify chain status
	code, body = get("/api/chain/" + c.ChainID)
	if code != 200 {
		log.Fatalf("get chain: %d", code)
	}
	var ch struct {
		Status string `json:"status"`
		Hops   []struct {
			Status string `json:"status"`
			Index  int    `json:"index"`
		} `json:"hops"`
	}
	json.Unmarshal(body, &ch)
	log.Printf("  chain status: %s", ch.Status)
	if ch.Status != "won" {
		log.Fatalf("expected won, got %s", ch.Status)
	}
	for _, h := range ch.Hops {
		if h.Status != "passed" {
			log.Fatalf("hop %d not passed: %s", h.Index, h.Status)
		}
	}
	log.Printf("  ✓ all %d hops passed", chainMax)
}

func killOnDoubleClaim() {
	log.Println("=== kill on double claim ===")
	originator := newSigner()
	rootURL := "sia://fake#xxx"
	archiveURL := "sia://fake-archive#xxx"
	rootHash := "feedface"
	sig := originator.sign("chain:create:" + rootURL + ":" + archiveURL + ":" + rootHash)
	code, body := post("/api/chain", map[string]string{
		"holder_pubkey": originator.pub,
		"holder_name":   "Alice",
		"share_url":     rootURL,
		"archive_url":   archiveURL,
		"root_hash":     rootHash,
		"signature":     sig,
	})
	if code != 200 {
		log.Fatalf("create chain: %d %s", code, body)
	}
	var c struct {
		ChainID   string `json:"chain_id"`
		PassHopID string `json:"pass_hop_id"`
	}
	json.Unmarshal(body, &c)

	// First heir successfully claims
	bob := newSigner()
	code, body = post("/api/hop/"+c.PassHopID+"/sign-init", nil)
	if code != 200 {
		log.Fatalf("sign-init: %d %s", code, body)
	}
	var ni struct{ Nonce string `json:"nonce"` }
	json.Unmarshal(body, &ni)
	code, body = post("/api/hop/"+c.PassHopID+"/sign", map[string]string{
		"pubkey":    bob.pub,
		"name":      "Bob",
		"nonce":     ni.Nonce,
		"signature": bob.sign("accept:" + c.PassHopID + ":" + ni.Nonce),
	})
	if code != 200 {
		log.Fatalf("bob's sign: %d %s", code, body)
	}
	log.Printf("  bob (%s) claimed", bob.pub[:14])

	// Charlie tries the same link with his own signature → should kill the chain
	charlie := newSigner()
	// Charlie may or may not get a fresh nonce; either way his sig will hit a claimed hop.
	code, body = post("/api/hop/"+c.PassHopID+"/sign-init", nil)
	if code == 200 {
		log.Fatalf("expected sign-init to refuse on claimed hop, got %d", code)
	}
	log.Printf("  sign-init on claimed hop refused (%d): %s", code, body)
	// Charlie tries to /sign anyway with a fresh nonce-shaped value (signed with his own key)
	madeUpNonce := "0102030405060708"
	code, body = post("/api/hop/"+c.PassHopID+"/sign", map[string]string{
		"pubkey":    charlie.pub,
		"name":      "Charlie",
		"nonce":     madeUpNonce,
		"signature": charlie.sign("accept:" + c.PassHopID + ":" + madeUpNonce),
	})
	if code != 410 {
		log.Fatalf("expected 410 chain killed, got %d: %s", code, body)
	}
	log.Printf("  charlie's attempt killed chain: %s", body)

	code, body = get("/api/chain/" + c.ChainID)
	var ch struct {
		Status       string `json:"status"`
		KillerPubkey string `json:"killer_pubkey"`
		KillReason   string `json:"kill_reason"`
	}
	json.Unmarshal(body, &ch)
	log.Printf("  chain status=%s killer=%s reason=%s", ch.Status, ch.KillerPubkey[:14], ch.KillReason)
	if ch.Status != "killed" {
		log.Fatalf("expected killed, got %s", ch.Status)
	}
	if ch.KillerPubkey != originator.pub {
		log.Fatalf("expected killer=originator (%s), got %s", originator.pub[:14], ch.KillerPubkey[:14])
	}
	if ch.KillReason != "double_claim" {
		log.Fatalf("expected reason=double_claim, got %s", ch.KillReason)
	}
	log.Println("  ✓ chain killed, originator blamed")
}

func selfPassRefused() {
	log.Println("=== self-pass refused ===")
	originator := newSigner()
	rootURL := "sia://fake-self#abc"
	archiveURL := "sia://fake-self-archive#abc"
	rootHash := "abcabcabc"
	sig := originator.sign("chain:create:" + rootURL + ":" + archiveURL + ":" + rootHash)
	code, body := post("/api/chain", map[string]string{
		"holder_pubkey": originator.pub,
		"holder_name":   "Solo",
		"share_url":     rootURL,
		"archive_url":   archiveURL,
		"root_hash":     rootHash,
		"signature":     sig,
	})
	if code != 200 {
		log.Fatalf("create: %d %s", code, body)
	}
	var c struct {
		ChainID   string `json:"chain_id"`
		PassHopID string `json:"pass_hop_id"`
	}
	json.Unmarshal(body, &c)

	// Originator tries to claim hop 1 as themselves.
	code, body = post("/api/hop/"+c.PassHopID+"/sign-init", nil)
	if code != 200 {
		log.Fatalf("sign-init: %d %s", code, body)
	}
	var ni struct {
		Nonce string `json:"nonce"`
	}
	json.Unmarshal(body, &ni)
	code, body = post("/api/hop/"+c.PassHopID+"/sign", map[string]string{
		"pubkey":    originator.pub,
		"name":      "Solo",
		"nonce":     ni.Nonce,
		"signature": originator.sign("accept:" + c.PassHopID + ":" + ni.Nonce),
	})
	if code != 409 {
		log.Fatalf("expected 409, got %d: %s", code, body)
	}
	log.Printf("  refused as expected: %s", body)
	log.Println("  ✓ self-pass blocked")
}

func main() {
	flag.StringVar(&base, "base", base, "server base URL")
	flag.Parse()
	happyPath()
	killOnDoubleClaim()
	selfPassRefused()
	log.Println("ALL OK")
}
