import { expect, mock, test } from 'claude-code/testing'

const SCROLL = { offset: 0, bodyRows: 40 }

test('the band draws both buttons on the surfaces that have a band', async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'bearings', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: SCROLL, view: {} },
    })
    expect((await band.find({ key: 'open-glossary' }))?.text).toBe('Glossary · 0 new')
    expect((await band.find({ key: 'open-bearings' }))?.text).toBe('Bearings · not built yet')
    await band.unmount()
  }
})

test('both panes draw a valid tree on every surface, with an input where the surface has one', async ($, on) => {
  mock.clock(on, { now: 0 })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const requestId of ['bearings-glossary', 'bearings-map']) {
      const pane = await $.ui.mount({
        plugin: 'bearings', surface, component: 'Pane', requestId,
        props: { title: requestId, isFocused: false, bodyColumns: 60, placement: 'inline', scroll: SCROLL, view: {} },
      })
      const inputs = await pane.findAll({ type: 'Input' })
      // Whether mobile has an Input differs between engine versions, so its count is not asserted.
      if (surface !== 'mobile') expect(inputs.length).toBe(1)
      await pane.unmount()
    }
  }
})
