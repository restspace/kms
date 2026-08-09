import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import "./ContextMenu.css";

export interface ContextMenuOption {
  label: string;
  onClick: () => void;
  /** Right-aligned, dimmed keystroke tip (e.g. "double-click", "⌘-click"). */
  hint?: string;
  disabled?: boolean;
}

export interface ContextMenuProps {
  position: { x: number; y: number; };
  options: ContextMenuOption[];
  onClose: () => void;
}

export const ContextMenu = ({ position, options, onClose }: ContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const openerRef = useRef<Element | null>(null);
  const [activeIndex, setActiveIndex] = useState(() => options.findIndex((o) => !o.disabled));
  const [style, setStyle] = useState<{ top: number; left: number }>({ top: position.y, left: position.x });

  useEffect(() => {
    const handleWindowClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const menuEl = menuRef.current;
      const clickedInsideMenu = !!(menuEl && menuEl.contains(target));
      if (!clickedInsideMenu) {
        onClose();
      }
    };

    // Defer attaching to avoid catching the same event that opened the menu
    const t = setTimeout(() => {
      window.addEventListener('click', handleWindowClick);
      window.addEventListener('contextmenu', handleWindowClick);
    }, 0);

    return () => {
      clearTimeout(t);
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('contextmenu', handleWindowClick);
    };
  }, [onClose]);

  // Focus management: remember opener, focus first enabled item on mount,
  // restore focus to opener on unmount.
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current as HTMLElement | null;
      opener?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (activeIndex >= 0) {
      itemRefs.current[activeIndex]?.focus();
    }
  }, [activeIndex]);

  // Viewport clamping: measure after mount and flip/clamp so the menu stays
  // fully on-screen.
  useLayoutEffect(() => {
    const menuEl = menuRef.current;
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = position.x;
    let top = position.y;
    if (left + rect.width > vw) left = Math.max(0, vw - rect.width);
    if (top + rect.height > vh) top = Math.max(0, vh - rect.height);
    setStyle({ top, left });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.x, position.y]);

  const enabledIndexes = () => options.map((_o, i) => i).filter((i) => !options[i].disabled);

  const moveTo = (index: number) => {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    if (enabled.includes(index)) {
      setActiveIndex(index);
    }
  };

  const moveBy = (delta: number) => {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    const currentPos = enabled.indexOf(activeIndex);
    const nextPos = currentPos === -1
      ? (delta > 0 ? 0 : enabled.length - 1)
      : (currentPos + delta + enabled.length) % enabled.length;
    setActiveIndex(enabled[nextPos]);
  };

  const activate = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    option.onClick();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveBy(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveBy(-1);
        break;
      case 'Home':
        e.preventDefault();
        moveTo(enabledIndexes()[0] ?? -1);
        break;
      case 'End': {
        e.preventDefault();
        const enabled = enabledIndexes();
        moveTo(enabled[enabled.length - 1] ?? -1);
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case 'Tab':
        onClose();
        break;
      default:
        break;
    }
  };

  const handleMenuClick = (e?: React.MouseEvent) => {
    e?.stopPropagation();
  };

  const menu = (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      data-testid="context-menu"
      style={{ top: style.top, left: style.left }}
      onClick={handleMenuClick}
      onContextMenu={(e) => { e.preventDefault(); handleMenuClick(e as any); }}
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => (
        <button
          key={index}
          ref={(el) => { itemRefs.current[index] = el; }}
          type="button"
          className="context-menu-item"
          role="menuitem"
          tabIndex={index === activeIndex ? 0 : -1}
          disabled={option.disabled}
          onClick={() => activate(index)}
          onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
        >
          <span className="context-menu-item-label">{option.label}</span>
          {option.hint && <span className="context-menu-item-hint">{option.hint}</span>}
        </button>
      ))}
    </div>
  );

  return typeof document !== 'undefined' ? ReactDOM.createPortal(menu, document.body) : null;
};
