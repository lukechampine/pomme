package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	hopLifetime    = 24 * time.Hour
	chainMaxLength = 5 // total hops including originator
)

type chainStatus string

const (
	chainAlive  chainStatus = "alive"
	chainWon    chainStatus = "won"
	chainKilled chainStatus = "killed"
)

type hopStatus string

const (
	hopUnclaimed hopStatus = "unclaimed"
	hopClaimed   hopStatus = "claimed"
	hopPassed    hopStatus = "passed"
)

type chain struct {
	ID           string      `json:"id"`
	Status       chainStatus `json:"status"`
	RootHopID    string      `json:"root_hop_id"`
	RootHash     string      `json:"root_hash"`
	CreatedAt    time.Time   `json:"created_at"`
	WonAt        *time.Time  `json:"won_at,omitempty"`
	KilledAt     *time.Time  `json:"killed_at,omitempty"`
	KillerPubkey string      `json:"killer_pubkey,omitempty"`
	KillerName   string      `json:"killer_name,omitempty"`
	KillReason   string      `json:"kill_reason,omitempty"`
}

type hop struct {
	ID           string     `json:"id"`
	ChainID      string     `json:"chain_id"`
	ParentHopID  string     `json:"parent_hop_id,omitempty"`
	Index        int        `json:"index"`
	Status       hopStatus  `json:"status"`
	HolderPubkey string     `json:"holder_pubkey,omitempty"`
	HolderName   string     `json:"holder_name,omitempty"`
	// ShareURL is the 24h-validity Sia URL the heir uses to claim this potato.
	// It expires naturally on the gameplay deadline — Sia's URL TTL is the
	// timer.
	ShareURL string `json:"share_url,omitempty"`
	// ArchiveURL is a long-lived Sia URL for the *same* object, used by the
	// chain status page so the chain remains visible long after the share URL
	// has expired. It does not affect gameplay.
	ArchiveURL string     `json:"archive_url,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	ClaimedAt  *time.Time `json:"claimed_at,omitempty"`
	PassedAt   *time.Time `json:"passed_at,omitempty"`
	ExpiresAt  time.Time  `json:"expires_at"`
	nonce      string
}

const maxNameLen = 32

func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > maxNameLen {
		s = s[:maxNameLen]
	}
	return s
}

type store struct {
	mu     sync.RWMutex
	chains map[string]*chain
	hops   map[string]*hop
}

func newStore() *store {
	return &store{chains: map[string]*chain{}, hops: map[string]*hop{}}
}

type server struct {
	store     *store
	publicURL string
	webDir    string
}

// ---------- helpers ----------

func newID() string {
	var b [16]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func newNonce() string {
	var b [32]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func parsePubkey(s string) (ed25519.PublicKey, error) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 || parts[0] != "ed25519" {
		return nil, fmt.Errorf("pubkey must look like ed25519:<hex>")
	}
	b, err := hex.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("pubkey hex decode: %w", err)
	}
	if len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("pubkey wrong length: %d", len(b))
	}
	return b, nil
}

func verifySig(pubkey, message, sigHex string) error {
	pk, err := parsePubkey(pubkey)
	if err != nil {
		return err
	}
	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		return fmt.Errorf("sig hex decode: %w", err)
	}
	if !ed25519.Verify(pk, []byte(message), sig) {
		return fmt.Errorf("signature verification failed")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, format string, args ...any) {
	writeJSON(w, code, map[string]string{"error": fmt.Sprintf(format, args...)})
}

// killChain marks the chain dead. Caller must hold s.store.mu.
func (s *server) killChain(c *chain, killerPubkey, killerName, reason string) {
	if c.Status != chainAlive {
		return
	}
	now := time.Now()
	c.Status = chainKilled
	c.KilledAt = &now
	c.KillerPubkey = killerPubkey
	c.KillerName = killerName
	c.KillReason = reason
}

// pubkeyInChain returns true iff pubkey already holds a hop in chainID.
// Caller must hold s.store.mu (read or write).
func (s *server) pubkeyInChain(chainID, pubkey string) bool {
	for _, h := range s.store.hops {
		if h.ChainID == chainID && h.HolderPubkey == pubkey {
			return true
		}
	}
	return false
}

// ---------- API: create chain ----------

type createChainReq struct {
	HolderPubkey string `json:"holder_pubkey"`
	HolderName   string `json:"holder_name"`
	ShareURL     string `json:"share_url"`
	ArchiveURL   string `json:"archive_url"`
	RootHash     string `json:"root_hash"`
	Signature    string `json:"signature"`
}

type createChainResp struct {
	ChainID   string `json:"chain_id"`
	RootHopID string `json:"root_hop_id"`
	PassHopID string `json:"pass_hop_id"`
	PassLink  string `json:"pass_link"`
}

func (s *server) handleCreateChain(w http.ResponseWriter, r *http.Request) {
	var req createChainReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad json: %v", err)
		return
	}
	if req.HolderPubkey == "" || req.ShareURL == "" || req.ArchiveURL == "" || req.RootHash == "" || req.Signature == "" {
		writeErr(w, 400, "missing required fields")
		return
	}
	msg := "chain:create:" + req.ShareURL + ":" + req.ArchiveURL + ":" + req.RootHash
	if err := verifySig(req.HolderPubkey, msg, req.Signature); err != nil {
		writeErr(w, 401, "bad signature: %v", err)
		return
	}

	now := time.Now()
	chainID := newID()
	rootID := newID()
	passID := newID()

	c := &chain{
		ID:        chainID,
		Status:    chainAlive,
		RootHopID: rootID,
		RootHash:  req.RootHash,
		CreatedAt: now,
	}
	root := &hop{
		ID:           rootID,
		ChainID:      chainID,
		Index:        0,
		Status:       hopPassed,
		HolderPubkey: req.HolderPubkey,
		HolderName:   sanitizeName(req.HolderName),
		ShareURL:     req.ShareURL,
		ArchiveURL:   req.ArchiveURL,
		CreatedAt:    now,
		ClaimedAt:    &now,
		PassedAt:     &now,
		ExpiresAt:    now.Add(hopLifetime),
	}
	pass := &hop{
		ID:          passID,
		ChainID:     chainID,
		ParentHopID: rootID,
		Index:       1,
		Status:      hopUnclaimed,
		CreatedAt:   now,
		ExpiresAt:   now.Add(hopLifetime),
	}

	s.store.mu.Lock()
	s.store.chains[chainID] = c
	s.store.hops[rootID] = root
	s.store.hops[passID] = pass
	s.store.mu.Unlock()

	writeJSON(w, 200, createChainResp{
		ChainID:   chainID,
		RootHopID: rootID,
		PassHopID: passID,
		PassLink:  s.publicURL + "/p/" + passID,
	})
}

// ---------- API: get hop ----------

type hopView struct {
	*hop
	ChainStatus      chainStatus `json:"chain_status"`
	ChainKillerPub   string      `json:"chain_killer_pubkey,omitempty"`
	ChainKillerName  string      `json:"chain_killer_name,omitempty"`
	ChainKillReason  string      `json:"chain_kill_reason,omitempty"`
	ParentShareURL   string      `json:"parent_share_url,omitempty"`
	ParentPubkey     string      `json:"parent_pubkey,omitempty"`
	ParentName       string      `json:"parent_name,omitempty"`
	PredecessorNames []string    `json:"predecessor_names,omitempty"`
	ChainTotal       int         `json:"chain_total"`
	// Set when this hop has been passed: the child hop awaiting a successor.
	NextHopID string `json:"next_hop_id,omitempty"`
	NextLink  string `json:"next_link,omitempty"`
}

func (s *server) handleGetHop(w http.ResponseWriter, r *http.Request) {
	hopID := r.PathValue("id")
	s.store.mu.RLock()
	defer s.store.mu.RUnlock()
	h, ok := s.store.hops[hopID]
	if !ok {
		writeErr(w, 404, "hop not found")
		return
	}
	c := s.store.chains[h.ChainID]
	view := hopView{
		hop:             h,
		ChainStatus:     c.Status,
		ChainKillerPub:  c.KillerPubkey,
		ChainKillerName: c.KillerName,
		ChainKillReason: c.KillReason,
		ChainTotal:      chainMaxLength,
	}
	if h.ParentHopID != "" {
		if p, ok := s.store.hops[h.ParentHopID]; ok {
			view.ParentShareURL = p.ShareURL
			view.ParentPubkey = p.HolderPubkey
			view.ParentName = p.HolderName
		}
	}
	// Build ordered list of predecessor display names (hops with index < this hop, in order).
	preds := make([]*hop, 0, h.Index)
	for _, other := range s.store.hops {
		if other.ChainID == h.ChainID && other.Index < h.Index && other.HolderPubkey != "" {
			preds = append(preds, other)
		}
	}
	for i := 1; i < len(preds); i++ {
		for j := i; j > 0 && preds[j].Index < preds[j-1].Index; j-- {
			preds[j], preds[j-1] = preds[j-1], preds[j]
		}
	}
	for _, p := range preds {
		view.PredecessorNames = append(view.PredecessorNames, p.HolderName)
	}
	// If this hop has been passed, find the awaiting-successor child so the
	// holder can come back later and re-share the pass link.
	if h.Status == hopPassed {
		for _, other := range s.store.hops {
			if other.ChainID == h.ChainID && other.ParentHopID == h.ID {
				view.NextHopID = other.ID
				view.NextLink = s.publicURL + "/p/" + other.ID
				break
			}
		}
	}
	writeJSON(w, 200, view)
}

// ---------- API: sign init ----------

type signInitResp struct {
	Nonce string `json:"nonce"`
}

func (s *server) handleSignInit(w http.ResponseWriter, r *http.Request) {
	hopID := r.PathValue("id")
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	h, ok := s.store.hops[hopID]
	if !ok {
		writeErr(w, 404, "hop not found")
		return
	}
	c := s.store.chains[h.ChainID]
	if c.Status != chainAlive {
		writeErr(w, 410, "chain is %s", c.Status)
		return
	}
	if h.Status != hopUnclaimed {
		writeErr(w, 409, "hop already %s", h.Status)
		return
	}
	// No server-side expiry check: the 24h deadline is enforced naturally by
	// the Sia share URL's TTL — a stale URL just won't decrypt.
	h.nonce = newNonce()
	writeJSON(w, 200, signInitResp{Nonce: h.nonce})
}

// ---------- API: sign (claim) ----------

type signReq struct {
	Pubkey    string `json:"pubkey"`
	Name      string `json:"name"`
	Nonce     string `json:"nonce"`
	Signature string `json:"signature"`
}

type signResp struct {
	OK bool `json:"ok"`
}

func (s *server) handleSign(w http.ResponseWriter, r *http.Request) {
	hopID := r.PathValue("id")
	var req signReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad json: %v", err)
		return
	}
	if req.Pubkey == "" || req.Nonce == "" || req.Signature == "" {
		writeErr(w, 400, "missing fields")
		return
	}

	msg := "accept:" + hopID + ":" + req.Nonce
	if err := verifySig(req.Pubkey, msg, req.Signature); err != nil {
		writeErr(w, 401, "bad signature: %v", err)
		return
	}

	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	h, ok := s.store.hops[hopID]
	if !ok {
		writeErr(w, 404, "hop not found")
		return
	}
	c := s.store.chains[h.ChainID]
	if c.Status != chainAlive {
		writeErr(w, 410, "chain is %s", c.Status)
		return
	}

	// Double-claim detection: if hop is already claimed/passed and a *different* pubkey signs,
	// the predecessor (the one who handed out this link) is the spammer; kill the chain.
	if h.Status != hopUnclaimed {
		if h.HolderPubkey != req.Pubkey {
			parent := s.store.hops[h.ParentHopID]
			var killerPub, killerName string
			if parent != nil {
				killerPub = parent.HolderPubkey
				killerName = parent.HolderName
			}
			s.killChain(c, killerPub, killerName, "double_claim")
			writeErr(w, 410, "chain killed: %s spammed this link", killerPub)
			return
		}
		// same holder reauthenticating; idempotent OK
		writeJSON(w, 200, signResp{OK: true})
		return
	}

	if h.nonce != req.Nonce {
		writeErr(w, 401, "nonce mismatch")
		return
	}

	// Self-pass prevention: a pubkey can hold at most one hop per chain.
	if s.pubkeyInChain(h.ChainID, req.Pubkey) {
		writeErr(w, 409, "you're already a holder in this chain — pass to someone else")
		return
	}

	now := time.Now()
	h.Status = hopClaimed
	h.HolderPubkey = req.Pubkey
	h.HolderName = sanitizeName(req.Name)
	h.ClaimedAt = &now
	h.ExpiresAt = now.Add(hopLifetime) // fresh 24h to pass
	h.nonce = ""
	writeJSON(w, 200, signResp{OK: true})
}

// ---------- API: pass ----------

type passReq struct {
	ShareURL   string `json:"share_url"`
	ArchiveURL string `json:"archive_url"`
	Signature  string `json:"signature"`
}

type passResp struct {
	NextHopID string `json:"next_hop_id,omitempty"`
	NextLink  string `json:"next_link,omitempty"`
	ChainWon  bool   `json:"chain_won"`
}

func (s *server) handlePass(w http.ResponseWriter, r *http.Request) {
	hopID := r.PathValue("id")
	var req passReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad json: %v", err)
		return
	}
	if req.ShareURL == "" || req.ArchiveURL == "" || req.Signature == "" {
		writeErr(w, 400, "missing fields")
		return
	}

	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	h, ok := s.store.hops[hopID]
	if !ok {
		writeErr(w, 404, "hop not found")
		return
	}
	c := s.store.chains[h.ChainID]
	if c.Status != chainAlive {
		writeErr(w, 410, "chain is %s", c.Status)
		return
	}
	if h.Status != hopClaimed {
		writeErr(w, 409, "hop is %s, expected claimed", h.Status)
		return
	}

	msg := "pass:" + hopID + ":" + req.ShareURL + ":" + req.ArchiveURL
	if err := verifySig(h.HolderPubkey, msg, req.Signature); err != nil {
		writeErr(w, 401, "bad signature: %v", err)
		return
	}

	now := time.Now()
	h.Status = hopPassed
	h.ShareURL = req.ShareURL
	h.ArchiveURL = req.ArchiveURL
	h.PassedAt = &now

	// Win condition: this was the last hop in the chain.
	if h.Index == chainMaxLength-1 {
		c.Status = chainWon
		c.WonAt = &now
		writeJSON(w, 200, passResp{ChainWon: true})
		return
	}

	// Otherwise create the next unclaimed hop.
	nextID := newID()
	next := &hop{
		ID:          nextID,
		ChainID:     c.ID,
		ParentHopID: hopID,
		Index:       h.Index + 1,
		Status:      hopUnclaimed,
		CreatedAt:   now,
		ExpiresAt:   now.Add(hopLifetime),
	}
	s.store.hops[nextID] = next
	writeJSON(w, 200, passResp{NextHopID: nextID, NextLink: s.publicURL + "/p/" + nextID})
}

// ---------- API: chains by pubkey ----------

type chainSummary struct {
	ChainID           string      `json:"chain_id"`
	Status            chainStatus `json:"status"`
	CreatedAt         time.Time   `json:"created_at"`
	WonAt             *time.Time  `json:"won_at,omitempty"`
	KilledAt          *time.Time  `json:"killed_at,omitempty"`
	UserHopID         string      `json:"user_hop_id"`
	UserHopIndex      int         `json:"user_hop_index"`
	UserHopStatus     hopStatus   `json:"user_hop_status"`
	CurrentHopIndex   int         `json:"current_hop_index"`
	ChainTotal        int         `json:"chain_total"`
	PredecessorName   string      `json:"predecessor_name,omitempty"`
	PredecessorPubkey string      `json:"predecessor_pubkey,omitempty"`
	SuccessorName     string      `json:"successor_name,omitempty"`
	SuccessorPubkey   string      `json:"successor_pubkey,omitempty"`
	KillerName        string      `json:"killer_name,omitempty"`
	KillerPubkey      string      `json:"killer_pubkey,omitempty"`
	KillReason        string      `json:"kill_reason,omitempty"`
}

func (s *server) handleChainsByPubkey(w http.ResponseWriter, r *http.Request) {
	pubkey := r.URL.Query().Get("pubkey")
	if pubkey == "" {
		writeErr(w, 400, "missing pubkey")
		return
	}
	s.store.mu.RLock()
	defer s.store.mu.RUnlock()

	type chainInfo struct {
		c       *chain
		userHop *hop
		byIdx   map[int]*hop
		maxIdx  int
	}
	byChainID := map[string]*chainInfo{}
	for _, h := range s.store.hops {
		inf := byChainID[h.ChainID]
		if inf == nil {
			c, ok := s.store.chains[h.ChainID]
			if !ok {
				continue
			}
			inf = &chainInfo{c: c, byIdx: map[int]*hop{}}
			byChainID[h.ChainID] = inf
		}
		inf.byIdx[h.Index] = h
		if h.HolderPubkey == pubkey {
			inf.userHop = h
		}
		if h.Index > inf.maxIdx {
			inf.maxIdx = h.Index
		}
	}

	result := make([]chainSummary, 0)
	for _, inf := range byChainID {
		if inf.userHop == nil {
			continue
		}
		var predName, predPub, succName, succPub string
		if pred := inf.byIdx[inf.userHop.Index-1]; pred != nil {
			predName = pred.HolderName
			predPub = pred.HolderPubkey
		}
		if succ := inf.byIdx[inf.userHop.Index+1]; succ != nil && succ.HolderPubkey != "" {
			succName = succ.HolderName
			succPub = succ.HolderPubkey
		}
		result = append(result, chainSummary{
			ChainID:           inf.c.ID,
			Status:            inf.c.Status,
			CreatedAt:         inf.c.CreatedAt,
			WonAt:             inf.c.WonAt,
			KilledAt:          inf.c.KilledAt,
			UserHopID:         inf.userHop.ID,
			UserHopIndex:      inf.userHop.Index,
			UserHopStatus:     inf.userHop.Status,
			CurrentHopIndex:   inf.maxIdx,
			ChainTotal:        chainMaxLength,
			PredecessorName:   predName,
			PredecessorPubkey: predPub,
			SuccessorName:     succName,
			SuccessorPubkey:   succPub,
			KillerName:        inf.c.KillerName,
			KillerPubkey:      inf.c.KillerPubkey,
			KillReason:        inf.c.KillReason,
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.After(result[j].CreatedAt) })
	writeJSON(w, 200, result)
}

// ---------- API: chain DAG ----------

type chainView struct {
	*chain
	Hops []*hop `json:"hops"`
}

func (s *server) handleGetChain(w http.ResponseWriter, r *http.Request) {
	chainID := r.PathValue("id")
	s.store.mu.RLock()
	defer s.store.mu.RUnlock()
	c, ok := s.store.chains[chainID]
	if !ok {
		writeErr(w, 404, "chain not found")
		return
	}
	var hops []*hop
	for _, h := range s.store.hops {
		if h.ChainID == chainID {
			hops = append(hops, h)
		}
	}
	// sort by index
	for i := 1; i < len(hops); i++ {
		for j := i; j > 0 && hops[j].Index < hops[j-1].Index; j-- {
			hops[j], hops[j-1] = hops[j-1], hops[j]
		}
	}
	writeJSON(w, 200, chainView{chain: c, Hops: hops})
}

// ---------- routing ----------

func (s *server) staticOrSPA(w http.ResponseWriter, r *http.Request) {
	// Block escape, allow only paths within webDir.
	cleanPath := filepath.Clean(r.URL.Path)
	if cleanPath == "/" || cleanPath == "" {
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, filepath.Join(s.webDir, "index.html"))
		return
	}
	candidate := filepath.Join(s.webDir, cleanPath)
	rel, err := filepath.Rel(s.webDir, candidate)
	if err != nil || strings.HasPrefix(rel, "..") {
		http.NotFound(w, r)
		return
	}
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		// Vendored assets (the WASM SDK) never change between commits — let
		// the browser cache them. Our own dev files are no-store so iterating
		// on them is cheap.
		if !strings.HasPrefix(cleanPath, "/vendor/") {
			w.Header().Set("Cache-Control", "no-store")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		http.ServeFile(w, r, candidate)
		return
	}
	// Not a file → SPA fallback (always fresh, contains our app shell).
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(s.webDir, "index.html"))
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/chain", s.handleCreateChain)
	mux.HandleFunc("GET /api/hop/{id}", s.handleGetHop)
	mux.HandleFunc("POST /api/hop/{id}/sign-init", s.handleSignInit)
	mux.HandleFunc("POST /api/hop/{id}/sign", s.handleSign)
	mux.HandleFunc("POST /api/hop/{id}/pass", s.handlePass)
	mux.HandleFunc("GET /api/chain/{id}", s.handleGetChain)
	mux.HandleFunc("GET /api/chains", s.handleChainsByPubkey)
	mux.HandleFunc("/", s.staticOrSPA)
	return mux
}

// ---------- main ----------

func main() {
	addr := flag.String("addr", "localhost:8765", "listen address")
	dir := flag.String("dir", "web", "web directory")
	publicURL := flag.String("public-url", "", "public URL (defaults to http://<addr>)")
	flag.Parse()
	if *publicURL == "" {
		*publicURL = "http://" + *addr
	}

	s := &server{
		store:     newStore(),
		publicURL: *publicURL,
		webDir:    *dir,
	}

	log.Printf("hotpotato server on http://%s (public %s, web %s)", *addr, s.publicURL, s.webDir)
	log.Fatal(http.ListenAndServe(*addr, s.routes()))
}
