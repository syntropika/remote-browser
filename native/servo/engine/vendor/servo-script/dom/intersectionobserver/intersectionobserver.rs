/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::cell::{Cell, RefCell};
use std::time::Duration;

use app_units::Au;
use cssparser::Parser;
use dom_struct::dom_struct;
use euclid::{Point2D, Rect, SideOffsets2D, Size2D, Vector2D};
use js::context::{JSContext, NoGC};
use js::rust::{HandleObject, MutableHandleValue};
use script_bindings::callback::{RootedCallback, TracedCallback};
use script_bindings::cell::DomRefCell;
use script_bindings::reflector::{Reflector, reflect_dom_object_with_proto};
use servo_base::cross_process_instant::CrossProcessInstant;
use servo_constellation_traits::ViewportIntersection;
use servo_geometry::f32_rect_to_au_rect;
use style::parser::Parse;
use style::stylesheets::CssRuleType;
use style::values::computed::Overflow;
use style::values::specified::intersection_observer::IntersectionObserverMargin;
use style_traits::{CSSPixel, ParsingMode, ToCss};

use crate::css::css::{ANONYMOUS_CONTENT_URL_DATA, parser_context_for_anonymous_content};
use crate::dom::bindings::callback::ExceptionHandling;
use crate::dom::bindings::codegen::Bindings::IntersectionObserverBinding::{
    IntersectionObserverCallback, IntersectionObserverInit, IntersectionObserverMethods,
};
use crate::dom::bindings::codegen::Bindings::WindowBinding::WindowMethods;
use crate::dom::bindings::codegen::UnionTypes::{DoubleOrDoubleSequence, ElementOrDocument};
use crate::dom::bindings::error::{Error, Fallible};
use crate::dom::bindings::inheritance::Castable;
use crate::dom::bindings::num::Finite;
use crate::dom::bindings::root::{Dom, DomRoot};
use crate::dom::bindings::str::DOMString;
use crate::dom::bindings::utils::to_frozen_array;
use crate::dom::document::{Document, RenderingUpdateReason};
use crate::dom::domrectreadonly::DOMRectReadOnly;
use crate::dom::element::Element;
use crate::dom::html::htmliframeelement::HTMLIFrameElement;
use crate::dom::intersectionobserverentry::IntersectionObserverEntry;
use crate::dom::node::{Node, NodeTraits};
use crate::dom::window::Window;

#[cfg_attr(crown, crown::unrooted_must_root_lint::must_root)]
#[derive(JSTraceable, MallocSizeOf)]
pub(crate) enum UnrootedElementOrDocument {
    Element(Dom<Element>),
    Document(Dom<Document>),
}

impl From<&ElementOrDocument> for UnrootedElementOrDocument {
    fn from(value: &ElementOrDocument) -> Self {
        match value {
            ElementOrDocument::Document(document) => {
                UnrootedElementOrDocument::Document(document.as_traced())
            },
            ElementOrDocument::Element(element) => {
                UnrootedElementOrDocument::Element(element.as_traced())
            },
        }
    }
}

impl From<&UnrootedElementOrDocument> for ElementOrDocument {
    fn from(value: &UnrootedElementOrDocument) -> Self {
        match value {
            UnrootedElementOrDocument::Document(document) => {
                ElementOrDocument::Document(document.as_rooted())
            },
            UnrootedElementOrDocument::Element(element) => {
                ElementOrDocument::Element(element.as_rooted())
            },
        }
    }
}

/// > The intersection root for an IntersectionObserver is the value of its root attribute if the attribute is non-null;
/// > otherwise, it is the top-level browsing context’s document node, referred to as the implicit root.
///
/// <https://w3c.github.io/IntersectionObserver/#intersectionobserver-intersection-root>
pub type IntersectionRoot = Option<UnrootedElementOrDocument>;

/// The Intersection Observer interface
///
/// > The IntersectionObserver interface can be used to observe changes in the intersection
/// > of an intersection root and one or more target Elements.
///
/// <https://w3c.github.io/IntersectionObserver/#intersection-observer-interface>
#[dom_struct]
pub(crate) struct IntersectionObserver {
    reflector_: Reflector,

    /// [`Document`] that should process this observer's observation steps.
    /// Following Chrome and Firefox, it is the current document on construction.
    /// <https://github.com/w3c/IntersectionObserver/issues/525>
    owner_doc: Dom<Document>,

    /// > The root provided to the IntersectionObserver constructor, or null if none was provided.
    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-root>
    root: IntersectionRoot,

    /// > This callback will be invoked when there are changes to a target’s intersection
    /// > with the intersection root, as per the processing model.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#intersection-observer-callback>
    callback: TracedCallback<IntersectionObserverCallback>,

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-queuedentries-slot>
    queued_entries: DomRefCell<Vec<Dom<IntersectionObserverEntry>>>,

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-observationtargets-slot>
    observation_targets: DomRefCell<Vec<Dom<Element>>>,

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-rootmargin-slot>
    #[no_trace]
    #[ignore_malloc_size_of = "Defined in style"]
    root_margin: RefCell<IntersectionObserverMargin>,

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-scrollmargin-slot>
    #[no_trace]
    #[ignore_malloc_size_of = "Defined in style"]
    scroll_margin: RefCell<IntersectionObserverMargin>,

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-thresholds-slot>
    thresholds: RefCell<Vec<Finite<f64>>>,

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-delay-slot>
    delay: Cell<i32>,

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-trackvisibility-slot>
    track_visibility: Cell<bool>,

    /// Whether or not this [`IntersectionObserver`] is connected to its owning [`Document`].
    connected_to_document: Cell<bool>,
}

impl IntersectionObserver {
    fn new_inherited(
        window: &Window,
        callback: RootedCallback<IntersectionObserverCallback>,
        root: &Option<ElementOrDocument>,
        root_margin: IntersectionObserverMargin,
        scroll_margin: IntersectionObserverMargin,
    ) -> Self {
        Self {
            reflector_: Reflector::new(),
            owner_doc: window.Document().as_traced(),
            root: root.as_ref().map(|root| root.into()),
            callback: callback.to_traced(),
            queued_entries: Default::default(),
            observation_targets: Default::default(),
            root_margin: RefCell::new(root_margin),
            scroll_margin: RefCell::new(scroll_margin),
            thresholds: Default::default(),
            delay: Default::default(),
            track_visibility: Default::default(),
            connected_to_document: Cell::new(false),
        }
    }

    /// <https://w3c.github.io/IntersectionObserver/#initialize-new-intersection-observer>
    fn new(
        cx: &mut JSContext,
        window: &Window,
        proto: Option<HandleObject>,
        callback: RootedCallback<IntersectionObserverCallback>,
        init: &IntersectionObserverInit,
    ) -> Fallible<DomRoot<Self>> {
        // Step 3.
        // > Attempt to parse a margin from options.rootMargin. If a list is returned,
        // > set this’s internal [[rootMargin]] slot to that. Otherwise, throw a SyntaxError exception.
        let root_margin = if let Ok(margin) = parse_a_margin(init.rootMargin.as_ref()) {
            margin
        } else {
            return Err(Error::Syntax(None));
        };

        // Step 4.
        // > Attempt to parse a margin from options.scrollMargin. If a list is returned,
        // > set this’s internal [[scrollMargin]] slot to that. Otherwise, throw a SyntaxError exception.
        let scroll_margin = if let Ok(margin) = parse_a_margin(init.scrollMargin.as_ref()) {
            margin
        } else {
            return Err(Error::Syntax(None));
        };

        // Step 1 and step 2, 3, 4 setter
        // > 1. Let this be a new IntersectionObserver object
        // > 2. Set this’s internal [[callback]] slot to callback.
        // > 3. ... set this’s internal [[rootMargin]] slot to that.
        // > 4. ... set this’s internal [[scrollMargin]] slot to that.
        let observer = reflect_dom_object_with_proto(
            cx,
            Box::new(Self::new_inherited(
                window,
                callback,
                &init.root,
                root_margin,
                scroll_margin,
            )),
            window,
            proto,
        );

        // Step 5-13
        observer.init_observer(init)?;

        Ok(observer)
    }

    /// Step 5-13 of <https://w3c.github.io/IntersectionObserver/#initialize-new-intersection-observer>
    fn init_observer(&self, init: &IntersectionObserverInit) -> Fallible<()> {
        // Step 5
        // > Let thresholds be a list equal to options.threshold.
        //
        // Non-sequence value should be converted into Vec.
        // Default value of thresholds is [0].
        let mut thresholds = match &init.threshold {
            Some(DoubleOrDoubleSequence::Double(num)) => vec![*num],
            Some(DoubleOrDoubleSequence::DoubleSequence(sequence)) => sequence.clone(),
            None => vec![Finite::wrap(0.)],
        };

        // Step 6
        // > If any value in thresholds is less than 0.0 or greater than 1.0, throw a RangeError exception.
        for num in &thresholds {
            if **num < 0.0 || **num > 1.0 {
                return Err(Error::Range(
                    c"Value in thresholds should not be less than 0.0 or greater than 1.0"
                        .to_owned(),
                ));
            }
        }

        // Step 7
        // > Sort thresholds in ascending order.
        thresholds.sort_by(|lhs, rhs| lhs.partial_cmp(&**rhs).unwrap());

        // Step 8
        // > If thresholds is empty, append 0 to thresholds.
        if thresholds.is_empty() {
            thresholds.push(Finite::wrap(0.));
        }

        // Step 9
        // > The thresholds attribute getter will return this sorted thresholds list.
        //
        // Set this internal [[thresholds]] slot to the sorted thresholds list
        // and getter will return the internal [[thresholds]] slot.
        self.thresholds.replace(thresholds);

        // Step 10
        // > Let delay be the value of options.delay.
        //
        // Default value of delay is 0.
        let mut delay = init.delay.unwrap_or(0);

        // Step 11
        // > If options.trackVisibility is true and delay is less than 100, set delay to 100.
        //
        // In Chromium, the minimum delay required is 100 milliseconds for observation that consider trackVisibilty.
        // Currently, visibility is not implemented.
        if init.trackVisibility {
            delay = delay.max(100);
        }

        // Step 12
        // > Set this’s internal [[delay]] slot to options.delay to delay.
        self.delay.set(delay);

        // Step 13
        // > Set this’s internal [[trackVisibility]] slot to options.trackVisibility.
        self.track_visibility.set(init.trackVisibility);

        Ok(())
    }

    /// <https://w3c.github.io/IntersectionObserver/#observe-target-element>
    fn observe_target_element(&self, target: &Element, no_gc: &NoGC) {
        // Step 1
        // > If target is in observer’s internal [[ObservationTargets]] slot, return.
        let is_present = self
            .observation_targets
            .borrow()
            .iter()
            .any(|element| &**element == target);
        if is_present {
            return;
        }

        // Step 2
        // > Let intersectionObserverRegistration be an IntersectionObserverRegistration record with
        // > an observer property set to observer, a previousThresholdIndex property set to -1,
        // > a previousIsIntersecting property set to false, and a previousIsVisible property set to false.
        // Step 3
        // > Append intersectionObserverRegistration to target’s internal [[RegisteredIntersectionObservers]] slot.
        target.add_initial_intersection_observer_registration(self, no_gc);

        if self.observation_targets.borrow().is_empty() {
            self.connect_to_owner();
        }

        // Step 4
        // > Add target to observer’s internal [[ObservationTargets]] slot.
        self.observation_targets
            .safe_borrow_mut(no_gc)
            .push(Dom::from_ref(target));

        target
            .owner_window()
            .Document()
            .add_rendering_update_reason(
                RenderingUpdateReason::IntersectionObserverStartedObservingTarget,
            );
    }

    /// <https://w3c.github.io/IntersectionObserver/#unobserve-target-element>
    fn unobserve_target_element(&self, target: &Element, no_gc: &NoGC) {
        // Step 1
        // > Remove the IntersectionObserverRegistration record whose observer property is equal to
        // > this from target’s internal [[RegisteredIntersectionObservers]] slot, if present.
        target
            .registered_intersection_observers_mut(no_gc)
            .retain(|registration| &*registration.observer != self);

        // Step 2
        // > Remove target from this’s internal [[ObservationTargets]] slot, if present
        self.observation_targets
            .safe_borrow_mut(no_gc)
            .retain(|element| &**element != target);

        // Should disconnect from owner if it is not observing anything.
        if self.observation_targets.borrow().is_empty() {
            self.disconnect_from_owner();
        }
    }

    /// <https://w3c.github.io/IntersectionObserver/#queue-an-intersectionobserverentry>
    #[allow(clippy::too_many_arguments)]
    fn queue_an_intersectionobserverentry(
        &self,
        cx: &mut JSContext,
        document: &Document,
        time: CrossProcessInstant,
        root_bounds: Option<Rect<Au, CSSPixel>>,
        bounding_client_rect: Rect<Au, CSSPixel>,
        intersection_rect: Rect<Au, CSSPixel>,
        is_intersecting: bool,
        is_visible: bool,
        intersection_ratio: f64,
        target: &Element,
    ) {
        let mut rect_to_domrectreadonly = |rect: Rect<Au, CSSPixel>| {
            DOMRectReadOnly::new(
                cx,
                self.owner_doc.window().as_global_scope(),
                None,
                rect.origin.x.to_f64_px(),
                rect.origin.y.to_f64_px(),
                rect.size.width.to_f64_px(),
                rect.size.height.to_f64_px(),
            )
        };

        let root_bounds = root_bounds.map(&mut rect_to_domrectreadonly);
        let bounding_client_rect = rect_to_domrectreadonly(bounding_client_rect);
        let intersection_rect = rect_to_domrectreadonly(intersection_rect);

        // Step 1. Construct an IntersectionObserverEntry, passing in time, rootBounds,
        // >    boundingClientRect, intersectionRect, isIntersecting, and target.
        let time = document
            .owner_global()
            .performance(cx)
            .to_dom_high_res_time_stamp(time);
        let entry = IntersectionObserverEntry::new(
            cx,
            self.owner_doc.window(),
            None,
            time,
            root_bounds.as_deref(),
            &bounding_client_rect,
            &intersection_rect,
            is_intersecting,
            is_visible,
            Finite::wrap(intersection_ratio),
            target,
        );

        // Step 2. Append it to observer's internal [[QueuedEntries]] slot.
        self.queued_entries
            .safe_borrow_mut(cx.no_gc())
            .push(entry.as_traced());

        // Step 3. Queue an intersection observer task for document.
        document.queue_an_intersection_observer_task();
    }

    /// Step 3.1-3.5 of <https://w3c.github.io/IntersectionObserver/#notify-intersection-observers-algo>
    pub(crate) fn invoke_callback_if_necessary(&self, cx: &mut js::context::JSContext) {
        // Step 1
        // > If observer’s internal [[QueuedEntries]] slot is empty, continue.
        if self.queued_entries.borrow().is_empty() {
            return;
        }

        // Step 2-3
        // We trivially moved the entries and root them.
        let queued_entries = self
            .queued_entries
            .take()
            .iter_mut()
            .map(|entry| entry.as_rooted())
            .collect();

        // Step 4-5
        let _ = self
            .callback
            .Call_(cx, self, queued_entries, self, ExceptionHandling::Report);
    }

    /// Connect the observer itself into owner doc if it is unconnected.
    /// If the [`IntersectionObserver`] is already connected, do nothing.
    fn connect_to_owner(&self) {
        if !self.connected_to_document.get() {
            self.owner_doc.add_intersection_observer(self);
            self.connected_to_document.set(true);
        }
    }

    /// Disconnect the observer itself from owner doc.
    /// If not connected to a [`Document`], do nothing.
    fn disconnect_from_owner(&self) {
        if self.connected_to_document.get() {
            self.owner_doc.remove_intersection_observer(self);
        }
    }

    /// <https://w3c.github.io/IntersectionObserver/#ref-for-intersectionobserver-content-clip>
    /// An Element is defined as having a content clip if its computed style has overflow properties
    /// that cause its content to be clipped to the element’s padding edge.
    // TODO: this is not clear for `overflow: clip` since it is clipped based on overflow clip rect.
    fn has_content_clip(element: &Element) -> bool {
        element
            .upcast::<Node>()
            .effective_overflow_without_reflow()
            .is_some_and(|overflow_axes| {
                overflow_axes.x != Overflow::Visible || overflow_axes.y != Overflow::Visible
            })
    }

    /// > The root intersection rectangle for an IntersectionObserver is
    /// > the rectangle we’ll use to check against the targets.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#intersectionobserver-root-intersection-rectangle>
    fn root_intersection_rectangle(
        &self,
        root: &ElementOrDocument,
        same_origin_domain_target: bool,
    ) -> Option<Rect<Au, CSSPixel>> {
        let intersection_rectangle = unexpanded_root_intersection_rectangle(root)?;

        // > When calculating the root intersection rectangle for a same-origin-domain target,
        // > the rectangle is then expanded according to the offsets in the IntersectionObserver’s
        // > [[rootMargin]] slot in a manner similar to CSS’s margin property, with the four values
        // > indicating the amount the top, right, bottom, and left edges, respectively, are offset by,
        // > with positive lengths indicating an outward offset. Percentages are resolved relative to
        // > the width of the undilated rectangle.
        if !same_origin_domain_target {
            return Some(intersection_rectangle);
        }
        let margin = Self::resolve_percentages_with_basis(
            &self.root_margin.borrow(),
            intersection_rectangle,
        );
        Some(intersection_rectangle.outer_rect(margin))
    }

    /// Return the intersection root for `target`, and whether `target` is same-origin-domain
    /// with it. For the implicit root, this is the top-level browsing context's document,
    /// which is `None` if that document is in another `ScriptThread`.
    /// <https://w3c.github.io/IntersectionObserver/#intersectionobserver-intersection-root>
    fn intersection_root_for_target(&self, target: &Element) -> (Option<ElementOrDocument>, bool) {
        if let Some(root) = &self.root {
            // An explicit root is in the same document as any target that is not skipped.
            return (Some(root.into()), true);
        }
        let Some(top_level_document) = target.owner_window().top_level_document_if_local() else {
            // Servo assigns documents that can become same-origin-domain to the same
            // `ScriptThread`, so a target is never same-origin-domain with a remote root.
            return (None, false);
        };
        let same_origin_domain = target
            .owner_document()
            .origin()
            .same_origin_domain(&top_level_document.origin());
        (
            Some(ElementOrDocument::Document(top_level_document)),
            same_origin_domain,
        )
    }

    /// Compute the visible part of the viewport nested in `iframe`, as fractions of the
    /// iframe's content box, for intersection observations in the nested document. This
    /// applies the clipping of an implicit-root observation but neither root nor scroll
    /// margins, since the nested document may be cross-origin-domain. Returns `None` while
    /// the visible area of an ancestor viewport in another `ScriptThread` is unknown.
    pub(crate) fn nested_viewport_intersection(
        iframe: &HTMLIFrameElement,
    ) -> Option<ViewportIntersection> {
        let element = iframe.upcast::<Element>();
        let Some(content_box) = element.upcast::<Node>().content_box_without_reflow() else {
            return Some(ViewportIntersection::NotVisible);
        };
        if content_box.size.width.0 <= 0 || content_box.size.height.0 <= 0 {
            return Some(ViewportIntersection::NotVisible);
        }
        let root = element
            .owner_window()
            .top_level_document_if_local()
            .map(ElementOrDocument::Document);
        let root = root.as_ref().and_then(|root| {
            unexpanded_root_intersection_rectangle(root).map(|rectangle| (root, rectangle))
        });
        let visible = match compute_the_intersection(element, root, content_box, None) {
            ComputedIntersection::Unknown => return None,
            ComputedIntersection::NotIntersecting => return Some(ViewportIntersection::NotVisible),
            ComputedIntersection::Intersecting(visible) => visible,
        };

        let content_box = au_rect_to_f32_rect(content_box);
        let visible = au_rect_to_f32_rect(visible);
        let fraction =
            |value: f32, start: f32, length: f32| ((value - start) / length).clamp(0., 1.);
        let left = fraction(visible.min_x(), content_box.min_x(), content_box.width());
        let right = fraction(visible.max_x(), content_box.min_x(), content_box.width());
        let top = fraction(visible.min_y(), content_box.min_y(), content_box.height());
        let bottom = fraction(visible.max_y(), content_box.min_y(), content_box.height());
        Some(ViewportIntersection::Visible(euclid::default::Rect::new(
            euclid::default::Point2D::new(left, top),
            euclid::default::Size2D::new(right - left, bottom - top),
        )))
    }

    /// Step 2.2.4-2.2.21 of <https://w3c.github.io/IntersectionObserver/#update-intersection-observations-algo>
    ///
    /// If some conditions require to skips "processing further", we will skips those steps and
    /// return default values conformant to step 2.2.4. See [`IntersectionObservationOutput::default_skipped`].
    ///
    /// Note that current draft specs skipped wrong steps, as it should skip computing fields that
    /// would result in different intersection entry other than the default entry per published spec.
    /// <https://www.w3.org/TR/intersection-observer/>
    ///
    /// Returns `None` if the target's intersection depends on the visible area of an ancestor
    /// viewport in another `ScriptThread` that has not been reported yet.
    fn maybe_compute_intersection_output(
        &self,
        target: &Element,
    ) -> Option<IntersectionObservationOutput> {
        // Step 5
        // > If the intersection root is not the implicit root, and target is not in
        // > the same document as the intersection root, skip to step 11.
        // Step 6
        // > If the intersection root is an Element, and target is not a descendant of
        // > the intersection root in the containing block chain, skip to step 11.
        let skipped = IntersectionObservationOutput::default_skipped(Some(Rect::zero()));
        match &self.root {
            Some(UnrootedElementOrDocument::Document(document))
                if document.as_rooted() != target.owner_document() =>
            {
                return Some(skipped);
            },
            Some(UnrootedElementOrDocument::Element(element)) => {
                // To ensure consistency, we also check for elements right now, but we can depend on the
                // layout query later.
                if element.owner_document() != target.owner_document() {
                    return Some(skipped);
                }
                if !element
                    .owner_window()
                    .is_containing_block_descendant_query_without_reflow(
                        element.upcast(),
                        target.upcast(),
                    )
                {
                    return Some(skipped);
                }
            },
            _ => {},
        }

        // > rootBounds: For a same-origin-domain target, this will be the root intersection
        // > rectangle. Otherwise, this will be null.
        // <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserverentry-rootbounds>
        let (root, same_origin_domain) = self.intersection_root_for_target(target);
        let maybe_root_bounds = root
            .as_ref()
            .and_then(|root| self.root_intersection_rectangle(root, same_origin_domain));
        let reported_root_bounds =
            same_origin_domain.then(|| maybe_root_bounds.unwrap_or_default());

        // Step 7
        // > Set targetRect to the DOMRectReadOnly obtained by getting the bounding box for target.
        let maybe_target_rect = target.upcast::<Node>().border_box_without_reflow();

        // Following the implementation of Gecko, we will skip further processing if these
        // information not available. This would also handle display none element.
        let Some(target_rect) = maybe_target_rect else {
            return Some(IntersectionObservationOutput::default_skipped(
                reported_root_bounds,
            ));
        };
        let root = match (root.as_ref(), maybe_root_bounds) {
            (Some(root), Some(root_bounds)) => Some((root, root_bounds)),
            (Some(_), None) => {
                return Some(IntersectionObservationOutput::default_skipped(
                    reported_root_bounds,
                ));
            },
            // The implicit root is in another `ScriptThread`. The visible area of the
            // viewport where the walk leaves this `ScriptThread` is used instead.
            (None, _) => None,
        };

        // TODO(stevennovaryo): we should probably also consider adding visibity check, ideally
        //                      it would require new query from LayoutThread.

        // Step 8
        // > Let intersectionRect be the result of running the compute the intersection algorithm on
        // > target and observer’s intersection root.
        let scroll_margin = self.scroll_margin.borrow();
        let maybe_intersection_rect = match compute_the_intersection(
            target,
            root,
            target_rect,
            same_origin_domain.then_some(&*scroll_margin),
        ) {
            ComputedIntersection::Unknown => return None,
            ComputedIntersection::NotIntersecting => None,
            ComputedIntersection::Intersecting(intersection_rect) => Some(intersection_rect),
        };
        let intersection_rect = maybe_intersection_rect.unwrap_or_default();

        // Step 9
        // > Let targetArea be targetRect’s area.
        // Step 10
        // > Let intersectionArea be intersectionRect’s area.
        // These steps are folded in Step 12, rewriting (w1 * h1) / (w2 * h2) as (w1 / w2) * (h1 / h2)
        // to avoid multiplication overflows.

        // Step 11
        // > Let isIntersecting be true if targetRect and rootBounds intersect or are edge-adjacent,
        // > even if the intersection has zero area (because rootBounds or targetRect have zero area).
        // Because we are considering edge-adjacent, instead of checking whether the rectangle is empty,
        // we are checking whether the rectangle is negative or not.
        let is_intersecting = maybe_intersection_rect.is_some();

        // Step 12
        // > If targetArea is non-zero, let intersectionRatio be intersectionArea divided by targetArea.
        // > Otherwise, let intersectionRatio be 1 if isIntersecting is true, or 0 if isIntersecting is false.
        let intersection_ratio = if target_rect.size.width.0 == 0 || target_rect.size.height.0 == 0
        {
            is_intersecting.into()
        } else {
            (intersection_rect.size.width.0 as f64 / target_rect.size.width.0 as f64) *
                (intersection_rect.size.height.0 as f64 / target_rect.size.height.0 as f64)
        };

        // Step 13
        // > Set thresholdIndex to the index of the first entry in observer.thresholds whose value is
        // > greater than intersectionRatio, or the length of observer.thresholds if intersectionRatio is
        // > greater than or equal to the last entry in observer.thresholds.
        let threshold_index = self
            .thresholds
            .borrow()
            .iter()
            .position(|threshold| **threshold > intersection_ratio)
            .unwrap_or(self.thresholds.borrow().len());

        // If the index is 0, the first threshold value is greater
        // than the observed ratio, so we're not actually matching yet.
        // The spec differentiates between this case and the case where
        // there is no intersection, but other browser engines do not.
        let threshold_index = if is_intersecting && threshold_index > 0 {
            ThresholdIndex::Matching(threshold_index)
        } else {
            ThresholdIndex::NotMatching
        };

        // Step 14
        // > Let isVisible be the result of running the visibility algorithm on target.
        // TODO: Implement visibility algorithm
        let is_visible = false;

        // We never report isIntersecting as true unless we have exceeded a threshold,
        // which matches other browser eengines.
        // See https://github.com/w3c/IntersectionObserver/issues/432 for background.
        let is_intersecting = matches!(threshold_index, ThresholdIndex::Matching(..));

        Some(IntersectionObservationOutput::new_computed(
            threshold_index,
            is_intersecting,
            target_rect,
            intersection_rect,
            intersection_ratio,
            is_visible,
            reported_root_bounds,
        ))
    }

    /// Step 2.2.1-2.2.21 of <https://w3c.github.io/IntersectionObserver/#update-intersection-observations-algo>
    pub(crate) fn update_intersection_observations_steps(
        &self,
        cx: &mut JSContext,
        document: &Document,
        time: CrossProcessInstant,
    ) {
        for target in &*self.observation_targets.borrow() {
            // Step 1
            // > Let registration be the IntersectionObserverRegistration record in target’s internal
            // > [[RegisteredIntersectionObservers]] slot whose observer property is equal to observer.
            let registration = target.get_intersection_observer_registration(self).unwrap();

            // Step 2
            // > If (time - registration.lastUpdateTime < observer.delay), skip further processing for target.
            if time - registration.last_update_time.get() <
                Duration::from_millis(self.delay.get().max(0) as u64)
            {
                continue;
            }

            // step 4-14
            // A target whose ancestor viewport area is not known yet keeps its registration
            // unchanged, so that its initial observation happens once that area is reported.
            let Some(intersection_output) = self.maybe_compute_intersection_output(target) else {
                continue;
            };

            // Step 3
            // > Set registration.lastUpdateTime to time.
            registration.last_update_time.set(time);

            // Step 15-17
            // > 15. Let previousThresholdIndex be the registration’s previousThresholdIndex property.
            // > 16. Let previousIsIntersecting be the registration’s previousIsIntersecting property.
            // > 17. Let previousIsVisible be the registration’s previousIsVisible property.
            let previous_threshold_index = registration.previous_threshold_index.get();
            let previous_is_intersecting = registration.previous_is_intersecting.get();
            let previous_is_visible = registration.previous_is_visible.get();

            // Step 18
            // > If thresholdIndex does not equal previousThresholdIndex, or
            // > if isIntersecting does not equal previousIsIntersecting, or
            // > if isVisible does not equal previousIsVisible,
            // > queue an IntersectionObserverEntry, passing in observer, time, rootBounds,
            // > targetRect, intersectionRect, isIntersecting, isVisible, and target.
            if Some(intersection_output.threshold_index) != previous_threshold_index ||
                intersection_output.is_intersecting != previous_is_intersecting ||
                intersection_output.is_visible != previous_is_visible
            {
                self.queue_an_intersectionobserverentry(
                    cx,
                    document,
                    time,
                    intersection_output.root_bounds,
                    intersection_output.target_rect,
                    intersection_output.intersection_rect,
                    intersection_output.is_intersecting,
                    intersection_output.is_visible,
                    intersection_output.intersection_ratio,
                    target,
                );
            }

            // Step 19-21
            // > 19. Assign thresholdIndex to registration’s previousThresholdIndex property.
            // > 20. Assign isIntersecting to registration’s previousIsIntersecting property.
            // > 21. Assign isVisible to registration’s previousIsVisible property.
            registration
                .previous_threshold_index
                .set(Some(intersection_output.threshold_index));
            registration
                .previous_is_intersecting
                .set(intersection_output.is_intersecting);
            registration
                .previous_is_visible
                .set(intersection_output.is_visible);
        }
    }

    fn resolve_percentages_with_basis(
        margin: &IntersectionObserverMargin,
        containing_block: Rect<Au, CSSPixel>,
    ) -> SideOffsets2D<Au, CSSPixel> {
        let inner = &margin.0;
        SideOffsets2D::new(
            inner.0.to_used_value(containing_block.height()),
            inner.1.to_used_value(containing_block.width()),
            inner.2.to_used_value(containing_block.height()),
            inner.3.to_used_value(containing_block.width()),
        )
    }
}

impl IntersectionObserverMethods<crate::DomTypeHolder> for IntersectionObserver {
    /// > The root provided to the IntersectionObserver constructor, or null if none was provided.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-root>
    fn GetRoot(&self) -> Option<ElementOrDocument> {
        self.root.as_ref().map(|root| root.into())
    }

    /// > Offsets applied to the root intersection rectangle, effectively growing or
    /// > shrinking the box that is used to calculate intersections. These offsets are only
    /// > applied when handling same-origin-domain targets; for cross-origin-domain targets
    /// > they are ignored.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-rootmargin>
    fn RootMargin(&self) -> DOMString {
        self.root_margin.borrow().to_css_string().into()
    }

    /// > Offsets are applied to scrollports on the path from intersection root to target,
    /// > effectively growing or shrinking the clip rects used to calculate intersections.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-scrollmargin>
    fn ScrollMargin(&self) -> DOMString {
        self.scroll_margin.borrow().to_css_string().into()
    }

    /// > A list of thresholds, sorted in increasing numeric order, where each threshold
    /// > is a ratio of intersection area to bounding box area of an observed target.
    /// > Notifications for a target are generated when any of the thresholds are crossed
    /// > for that target. If no options.threshold was provided to the IntersectionObserver
    /// > constructor, or the sequence is empty, the value of this attribute will be `[0]`.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-thresholds>
    fn Thresholds(&self, cx: &mut JSContext, retval: MutableHandleValue) {
        to_frozen_array(cx, &self.thresholds.borrow(), retval);
    }

    /// > A number indicating the minimum delay in milliseconds between notifications from
    /// > this observer for a given target.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-delay>
    fn Delay(&self) -> i32 {
        self.delay.get()
    }

    /// > A boolean indicating whether this IntersectionObserver will track changes in a target’s visibility.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-trackvisibility>
    fn TrackVisibility(&self) -> bool {
        self.track_visibility.get()
    }

    /// > Run the observe a target Element algorithm, providing this and target.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-observe>
    fn Observe(&self, no_gc: &NoGC, target: &Element) {
        self.observe_target_element(target, no_gc);
    }

    /// > Run the unobserve a target Element algorithm, providing this and target.
    ///
    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-unobserve>
    fn Unobserve(&self, no_gc: &NoGC, target: &Element) {
        self.unobserve_target_element(target, no_gc);
    }

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-disconnect>
    fn Disconnect(&self, no_gc: &NoGC) {
        // > For each target in this’s internal [[ObservationTargets]] slot:
        self.observation_targets.borrow().iter().for_each(|target| {
            // > 1. Remove the IntersectionObserverRegistration record whose observer property is equal to
            // >    this from target’s internal [[RegisteredIntersectionObservers]] slot.
            target.remove_intersection_observer(self, no_gc);
        });
        // > 2. Remove target from this’s internal [[ObservationTargets]] slot.
        self.observation_targets.safe_borrow_mut(no_gc).clear();

        // We should remove this observer from the event loop.
        self.disconnect_from_owner();
    }

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-takerecords>
    fn TakeRecords(&self) -> Vec<DomRoot<IntersectionObserverEntry>> {
        // Step 1-3.
        self.queued_entries
            .take()
            .iter()
            .map(|entry| entry.as_rooted())
            .collect()
    }

    /// <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserver-intersectionobserver>
    fn Constructor(
        cx: &mut JSContext,
        window: &Window,
        proto: Option<HandleObject>,
        callback: RootedCallback<IntersectionObserverCallback>,
        init: &IntersectionObserverInit,
    ) -> Fallible<DomRoot<IntersectionObserver>> {
        Self::new(cx, window, proto, callback, init)
    }
}

#[derive(Clone, Copy, Debug, JSTraceable, MallocSizeOf, PartialEq)]
enum ThresholdIndex {
    NotMatching,
    Matching(usize),
}

/// <https://w3c.github.io/IntersectionObserver/#intersectionobserverregistration>
#[derive(Clone, JSTraceable, MallocSizeOf)]
#[cfg_attr(crown, crown::unrooted_must_root_lint::must_root)]
pub(crate) struct IntersectionObserverRegistration {
    pub(crate) observer: Dom<IntersectionObserver>,
    previous_threshold_index: Cell<Option<ThresholdIndex>>,
    previous_is_intersecting: Cell<bool>,
    #[no_trace]
    last_update_time: Cell<CrossProcessInstant>,
    previous_is_visible: Cell<bool>,
}

impl IntersectionObserverRegistration {
    /// Initial value of [`IntersectionObserverRegistration`] according to
    /// step 2 of <https://w3c.github.io/IntersectionObserver/#observe-target-element>.
    /// > Let intersectionObserverRegistration be an IntersectionObserverRegistration record with
    /// > an observer property set to observer, a previousThresholdIndex property set to -1,
    /// > a previousIsIntersecting property set to false, and a previousIsVisible property set to false.
    pub(crate) fn new_initial(observer: &IntersectionObserver) -> Self {
        IntersectionObserverRegistration {
            observer: Dom::from_ref(observer),
            previous_threshold_index: Cell::new(None),
            previous_is_intersecting: Cell::new(false),
            last_update_time: Cell::new(CrossProcessInstant::epoch()),
            previous_is_visible: Cell::new(false),
        }
    }
}

/// <https://w3c.github.io/IntersectionObserver/#parse-a-margin>
fn parse_a_margin(value: Option<&DOMString>) -> Result<IntersectionObserverMargin, ()> {
    // <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserverinit-rootmargin> &&
    // <https://w3c.github.io/IntersectionObserver/#dom-intersectionobserverinit-scrollmargin>
    // > ... defaulting to "0px".
    let value = match value {
        Some(str) => &str.str(),
        _ => "0px",
    };

    // Create necessary style ParserContext and utilize stylo's IntersectionObserverMargin
    let mut parser = Parser::new(value);

    let context = parser_context_for_anonymous_content(
        CssRuleType::Style,
        ParsingMode::DEFAULT,
        &ANONYMOUS_CONTENT_URL_DATA,
    );

    parser
        .parse_entirely(|p| IntersectionObserverMargin::parse(&context, p))
        .map_err(|_| ())
}

/// In terms of intersection observer, we consider zero-area rectangles as long as the area is not negative.
fn intersect_rectangle(
    lhs: &Rect<Au, CSSPixel>,
    rhs: &Rect<Au, CSSPixel>,
) -> Option<Rect<Au, CSSPixel>> {
    let box_result = lhs.to_box2d().intersection_unchecked(&rhs.to_box2d());
    if box_result.is_negative() {
        None
    } else {
        Some(box_result.to_rect())
    }
}

/// The intersection root rectangle without any root margin.
/// <https://w3c.github.io/IntersectionObserver/#intersectionobserver-root-intersection-rectangle>
fn unexpanded_root_intersection_rectangle(root: &ElementOrDocument) -> Option<Rect<Au, CSSPixel>> {
    match root {
        // Handle if root is an element.
        ElementOrDocument::Element(element) => {
            // TODO: recheck scrollbar approach and clip-path clipping from Chromium implementation.
            if IntersectionObserver::has_content_clip(element) {
                // > Otherwise, if the intersection root has a content clip, it’s the element’s padding area.
                element.upcast::<Node>().padding_box_without_reflow()
            } else {
                // > Otherwise, it’s the result of getting the bounding box for the intersection root.
                element.upcast::<Node>().border_box_without_reflow()
            }
        },
        // Handle if root is a Document, which includes implicit root and explicit Document root.
        ElementOrDocument::Document(document) => {
            // > If the intersection root is a document, it’s the size of the document's viewport
            // > (note that this processing step can only be reached if the document is fully active).
            // TODO: viewport should consider native scrollbar if exist. Recheck Servo's scrollbar approach.
            let viewport = document.window().viewport_details().size;
            Some(Rect::from_size(Size2D::new(
                Au::from_f32_px(viewport.width),
                Au::from_f32_px(viewport.height),
            )))
        },
    }
}

fn au_rect_to_f32_rect(rect: Rect<Au, CSSPixel>) -> Rect<f32, CSSPixel> {
    Rect::new(
        Point2D::new(rect.origin.x.to_f32_px(), rect.origin.y.to_f32_px()),
        Size2D::new(rect.size.width.to_f32_px(), rect.size.height.to_f32_px()),
    )
}

/// Maps rectangles from the viewport of a nested document into the viewport of an ancestor
/// document, with a scale for each axis followed by a translation. Layout reports the
/// bounding box of a transformed `<iframe>`, so this is exact for translations and scales
/// and approximates the bounding box of other transforms, such as rotations.
#[derive(Clone, Copy)]
struct ViewportMapping {
    scale: Vector2D<f32, CSSPixel>,
    offset: Vector2D<f32, CSSPixel>,
}

impl ViewportMapping {
    fn identity() -> Self {
        Self {
            scale: Vector2D::new(1., 1.),
            offset: Vector2D::zero(),
        }
    }

    /// The mapping of a nested viewport of `viewport_size` that is displayed in
    /// `content_box` of its container, in the parent viewport's coordinates.
    fn for_container(
        content_box: Rect<Au, CSSPixel>,
        viewport_size: Size2D<f32, CSSPixel>,
    ) -> Self {
        let content_box = au_rect_to_f32_rect(content_box);
        let scale = |displayed: f32, nested: f32| if nested > 0. { displayed / nested } else { 1. };
        Self {
            scale: Vector2D::new(
                scale(content_box.width(), viewport_size.width),
                scale(content_box.height(), viewport_size.height),
            ),
            offset: content_box.origin.to_vector(),
        }
    }

    /// The mapping that applies `self` and then `outer`.
    fn then(self, outer: Self) -> Self {
        Self {
            scale: self.scale.component_mul(outer.scale),
            offset: self.offset.component_mul(outer.scale) + outer.offset,
        }
    }

    fn map(&self, rect: Rect<Au, CSSPixel>) -> Rect<Au, CSSPixel> {
        let rect = au_rect_to_f32_rect(rect);
        f32_rect_to_au_rect(Rect::new(
            (rect.origin.to_vector().component_mul(self.scale) + self.offset).to_point(),
            Size2D::new(rect.width() * self.scale.x, rect.height() * self.scale.y),
        ))
    }

    fn unmap(&self, rect: Rect<Au, CSSPixel>) -> Rect<Au, CSSPixel> {
        let rect = au_rect_to_f32_rect(rect);
        let divide = |value: f32, scale: f32| if scale > 0. { value / scale } else { 0. };
        let origin = rect.origin - self.offset;
        f32_rect_to_au_rect(Rect::new(
            Point2D::new(
                divide(origin.x, self.scale.x),
                divide(origin.y, self.scale.y),
            ),
            Size2D::new(
                divide(rect.width(), self.scale.x),
                divide(rect.height(), self.scale.y),
            ),
        ))
    }
}

/// The result of [`compute_the_intersection`].
enum ComputedIntersection {
    /// The intersection rectangle, in the coordinate space of the target document's viewport.
    Intersecting(Rect<Au, CSSPixel>),
    NotIntersecting,
    /// The intersection depends on the visible area of an ancestor viewport whose embedding
    /// document is in another `ScriptThread`, which has not reported it yet.
    Unknown,
}

/// Compute the intersection rectangle of the target [`Element`] returning the results of intersection in the coordinate
/// space of the target's owning [`Document`]. Additionally, we assume that both the target and the root is connected.
/// <https://w3c.github.io/IntersectionObserver/#compute-the-intersection>
///
/// `root` is the intersection root and its root intersection rectangle. It is `None` if the
/// implicit root is in another `ScriptThread`. When the walk reaches a document whose parent is
/// in another `ScriptThread`, the visible area of that document's viewport reported by its
/// parent replaces the remaining ancestors and the root intersection rectangle. That area is
/// clipped by all ancestors and the top-level viewport, without any root or scroll margins.
fn compute_the_intersection(
    target: &Element,
    root: Option<(&ElementOrDocument, Rect<Au, CSSPixel>)>,
    target_rect: Rect<Au, CSSPixel>,
    scroll_margin: Option<&IntersectionObserverMargin>,
) -> ComputedIntersection {
    // > 1. Let intersectionRect be the result of getting the bounding box for target.
    // We had delegated the computation of this to the caller of the function.
    let mut intersection_rect = target_rect;

    // > 2. Let container be the containing block of target.
    let mut container = match target
        .upcast::<Node>()
        .containing_block_node_without_reflow()
    {
        Some(node) => ElementOrDocument::Element(DomRoot::downcast(node).unwrap()),
        None => ElementOrDocument::Document(target.owner_document()),
    };

    // The mapping from the target document's viewport to the viewport of the document
    // currently traversed, gained from traversing through multiple navigables.
    let mut total_mapping = ViewportMapping::identity();

    // > 3. While container is not root:
    while root.is_none_or(|(root, _)| container != *root) {
        let containing_element = match container {
            ElementOrDocument::Document(ref containing_document) => {
                // > 3.1. If container is the document of a nested browsing context, update intersectionRect by clipping
                // >      to the viewport of the document, and update container to be the browsing context container of container.
                let window = containing_document.window();
                let viewport_size = window.viewport_details().size;
                let viewport_rect = f32_rect_to_au_rect(Rect::from_size(viewport_size));
                let Some(clipped_rect) = intersect_rectangle(&intersection_rect, &viewport_rect)
                else {
                    return ComputedIntersection::NotIntersecting;
                };

                if let Some(frame_container) = containing_document
                    .browsing_context()
                    .and_then(|window| window.frame_element().map(DomRoot::from_ref))
                {
                    // The nested viewport starts at the content edge of its container.
                    let Some(content_box) = frame_container
                        .upcast::<Node>()
                        .content_box_without_reflow()
                    else {
                        return ComputedIntersection::NotIntersecting;
                    };
                    let mapping = ViewportMapping::for_container(content_box, viewport_size);
                    intersection_rect = mapping.map(clipped_rect);
                    total_mapping = total_mapping.then(mapping);

                    frame_container
                } else if !window.is_top_level() {
                    // The container is in another `ScriptThread`, which reports the visible part
                    // of this viewport after clipping by every ancestor.
                    let visible_fraction = match window.viewport_intersection() {
                        None => return ComputedIntersection::Unknown,
                        Some(ViewportIntersection::NotVisible) => {
                            return ComputedIntersection::NotIntersecting;
                        },
                        Some(ViewportIntersection::Visible(visible_fraction)) => visible_fraction,
                    };
                    let visible_rect = f32_rect_to_au_rect(Rect::new(
                        Point2D::new(
                            visible_fraction.origin.x * viewport_size.width,
                            visible_fraction.origin.y * viewport_size.height,
                        ),
                        Size2D::new(
                            visible_fraction.size.width * viewport_size.width,
                            visible_fraction.size.height * viewport_size.height,
                        ),
                    ));
                    return match intersect_rectangle(&clipped_rect, &visible_rect) {
                        Some(rect) => ComputedIntersection::Intersecting(total_mapping.unmap(rect)),
                        None => ComputedIntersection::NotIntersecting,
                    };
                } else {
                    // This top-level document is not the intersection root, which can only happen
                    // if the root is not an ancestor of the target.
                    break;
                }
            },
            ElementOrDocument::Element(ref root) => root.clone(),
        };

        // > 3.2. Map intersectionRect to the coordinate space of container.
        // TODO(#35767): We don't map the coordinate space per each iteration yet, instead all the rectangles are
        // in the viewport coordinate space. But this would cause the scroll margin calculation to be inaccurate
        // with respect to transforms.

        // > 3.3. If container is a scroll container, apply the IntersectionObserver’s [[scrollMargin]]
        // >      to the container’s clip rect as described in apply scroll margin to a scrollport.
        // > 3.4. If container has a content clip or a css clip-path property, update intersectionRect
        // >      by applying container’s clip.
        // TODO(#35767): handle `overflow: clip` and resolve clipping for x-axis and y-axis independently.
        // Additionally, handle css `clip-path` as well.
        if IntersectionObserver::has_content_clip(&containing_element) &&
            let Some(container_padding_box) = containing_element
                .upcast::<Node>()
                .padding_box_without_reflow()
        {
            let container_padding_box = match scroll_margin {
                Some(scroll_margin)
                    if containing_element.establishes_scroll_container_without_reflow() =>
                {
                    let margin = IntersectionObserver::resolve_percentages_with_basis(
                        scroll_margin,
                        container_padding_box,
                    );
                    container_padding_box.outer_rect(margin)
                },
                _ => container_padding_box,
            };

            let Some(clipped_rect) =
                intersect_rectangle(&intersection_rect, &container_padding_box)
            else {
                return ComputedIntersection::NotIntersecting;
            };
            intersection_rect = clipped_rect;
        }

        // > 3.5. If container is the root element of a browsing context, update container to be the
        // >      browsing context’s document; otherwise, update container to be the containing block
        // >      of container.
        // Additionally, for a node that doesn't have an element that establishes its containing block, we should
        // refer to the browsing context's document.
        container = match containing_element
            .upcast::<Node>()
            .containing_block_node_without_reflow()
            .and_then(DomRoot::downcast::<Element>)
        {
            Some(element) => ElementOrDocument::Element(element),
            None => ElementOrDocument::Document(containing_element.owner_document()),
        };
    }

    // Step 4
    // > Map intersectionRect to the coordinate space of root.
    // TODO(#35767): we don't map the coordinate space per each iteration yet, instead all the rectangles are
    // in the viewport coordinate space.

    // Step 5
    // > Update intersectionRect by intersecting it with the root intersection rectangle.
    let Some((_, root_bounds)) = root else {
        return ComputedIntersection::NotIntersecting;
    };
    let Some(intersection_rect) = intersect_rectangle(&intersection_rect, &root_bounds) else {
        return ComputedIntersection::NotIntersecting;
    };

    // Step 6
    // > Map intersectionRect to the coordinate space of the viewport of the document containing target.
    // Map the intersectionRect back to the coordinate space of target's document.
    // Step 7
    // > Return intersectionRect.
    ComputedIntersection::Intersecting(total_mapping.unmap(intersection_rect))
}

/// The values from computing step 2.2.4-2.2.14 in
/// <https://w3c.github.io/IntersectionObserver/#update-intersection-observations-algo>.
/// See [`IntersectionObserver::maybe_compute_intersection_output`].
struct IntersectionObservationOutput {
    pub(crate) threshold_index: ThresholdIndex,
    pub(crate) is_intersecting: bool,
    pub(crate) target_rect: Rect<Au, CSSPixel>,
    pub(crate) intersection_rect: Rect<Au, CSSPixel>,
    pub(crate) intersection_ratio: f64,
    pub(crate) is_visible: bool,

    /// The root intersection rectangle [`IntersectionObserver::root_intersection_rectangle`],
    /// which is `None` for a target that is not same-origin-domain with the intersection root.
    /// If the processing is skipped, computation should report the default zero value.
    pub(crate) root_bounds: Option<Rect<Au, CSSPixel>>,
}

impl IntersectionObservationOutput {
    /// Default values according to
    /// <https://w3c.github.io/IntersectionObserver/#update-intersection-observations-algo>.
    /// Step 4.
    /// > Let:
    /// > - thresholdIndex be 0.
    /// > - isIntersecting be false.
    /// > - targetRect be a DOMRectReadOnly with x, y, width, and height set to 0.
    /// > - intersectionRect be a DOMRectReadOnly with x, y, width, and height set to 0.
    ///
    /// For fields that the default values is not directly mentioned, the values conformant
    /// to current browser implementation or WPT test is used instead.
    fn default_skipped(root_bounds: Option<Rect<Au, CSSPixel>>) -> Self {
        Self {
            threshold_index: ThresholdIndex::NotMatching,
            is_intersecting: false,
            target_rect: Rect::zero(),
            intersection_rect: Rect::zero(),
            intersection_ratio: 0.,
            is_visible: false,
            root_bounds,
        }
    }

    fn new_computed(
        threshold_index: ThresholdIndex,
        is_intersecting: bool,
        target_rect: Rect<Au, CSSPixel>,
        intersection_rect: Rect<Au, CSSPixel>,
        intersection_ratio: f64,
        is_visible: bool,
        root_bounds: Option<Rect<Au, CSSPixel>>,
    ) -> Self {
        Self {
            threshold_index,
            is_intersecting,
            target_rect,
            intersection_rect,
            intersection_ratio,
            is_visible,
            root_bounds,
        }
    }
}

impl script_bindings::callback::OwnerWindow<crate::DomTypeHolder> for IntersectionObserver {}
