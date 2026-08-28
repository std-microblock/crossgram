export async function apply(ctx) {
  const statistics = ctx.get('mtprotoStatistics')
  if (!statistics) {
    throw new Error(
      'mtprotoStatistics service is unavailable; deploy a Crossgram revision that provides it',
    )
  }
  await ctx.debugScript.publish(
    statistics.read({ seconds: 300, minutes: 180, hours: 48 }),
  )
}
