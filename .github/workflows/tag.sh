TAG=v$(cat package.json | grep '"version":' | cut -d '"' -f 4)

REG=^$(echo $TAG | sed 's/\./\\./g')$

if [ -z "$(git tag -l | grep $REG)" ]; then
  echo new version detected: $TAG
  echo "tag=$TAG" >> $GITHUB_OUTPUT
fi
