#!/bin/zsh

PROJECT_DIR="/Users/user/Downloads/indigo-scraper-v2"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project folder not found: $PROJECT_DIR"
  read -k 1 "?Press any key to close..."
  echo
  exit 1
fi

cd "$PROJECT_DIR" || exit 1

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

export AUTO_OPEN_BROWSER=true
export WEB_HOST=127.0.0.1
export WEB_PORT=8787

node src/web/server.js
