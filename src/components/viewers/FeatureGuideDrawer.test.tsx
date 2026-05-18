// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { focusGuideTargetElement } from './FeatureGuideDrawer'

describe('focusGuideTargetElement', () => {
  it('focuses the first enabled control inside a guide target', () => {
    const target = document.createElement('section')
    const hiddenInput = document.createElement('input')
    hiddenInput.type = 'hidden'
    const textInput = document.createElement('input')
    textInput.type = 'text'
    target.append(hiddenInput, textInput)
    document.body.appendChild(target)

    expect(focusGuideTargetElement(target)).toBe(true)
    expect(document.activeElement).toBe(textInput)

    target.remove()
  })

  it('skips disabled controls and focuses the next usable control', () => {
    const target = document.createElement('div')
    const disabledButton = document.createElement('button')
    disabledButton.disabled = true
    const enabledButton = document.createElement('button')
    target.append(disabledButton, enabledButton)
    document.body.appendChild(target)

    expect(focusGuideTargetElement(target)).toBe(true)
    expect(document.activeElement).toBe(enabledButton)

    target.remove()
  })
})
