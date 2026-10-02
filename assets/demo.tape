Output assets/demo.gif
Set Width 1320
Set Height 600
Set FontFamily "DejaVu Sans Mono"
Set FontSize 18
Set Theme "Builtin Light"
Set TypingSpeed 1ms
Hide
Type "node bin/gha-rerun-ledger.js --demo | sed -n '1,17p'"
Enter
Sleep 3s
Show
Sleep 8s
Hide
Ctrl+L
Type "node bin/gha-rerun-ledger.js --input fixtures/demo-snapshot.json | sed -n '1,17p'"
Enter
Sleep 3s
Show
Sleep 8s
