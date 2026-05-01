.PHONY: serve

serve:
	go run ./cmd/server -addr localhost:8765 -dir web
