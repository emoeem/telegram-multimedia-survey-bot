import glob
files = glob.glob("dist/assets/survey-*.js")
for f in files:
    with open(f) as fh:
        content = fh.read()
    idx = 0
    while True:
        idx = content.find('data-theme', idx)
        if idx < 0:
            break
        start = max(0, idx - 50)
        end = min(len(content), idx + 80)
        print(f"  Context: ...{content[start:end]}...")
        idx += 1
    print()
